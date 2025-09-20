# main.py
# Project Sentinel Core - robust dev-friendly version
# - optional heavy libs are imported safely
# - pydantic-settings handled robustly
# - missing optional features return informative errors rather than crashing import-time

import os
import hashlib
import json
import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

# FastAPI
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.websockets import WebSocketDisconnect
import uvicorn

# --- pydantic settings import (robust fallback) ---
try:
    from pydantic_settings import BaseSettings
    from pydantic import BaseModel, Field, validator
except Exception:
    # minimal fallback if pydantic-settings not available
    from pydantic import BaseModel, Field, validator, ValidationError

    def _load_dotenv_file(path: str) -> Dict[str, str]:
        env_map: Dict[str, str] = {}
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    s = raw.strip()
                    if not s or s.startswith("#"):
                        continue
                    if "=" not in s:
                        continue
                    k, v = s.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('\'"')
                    env_map[k] = v
        except FileNotFoundError:
            pass
        return env_map

    class BaseSettings(BaseModel):
        def __init__(self, **data):
            env_file = None
            model_conf = getattr(self.__class__, "model_config", None) or {}
            if isinstance(model_conf, dict):
                env_file = model_conf.get("env_file")
            env_map = {}
            if env_file:
                env_map = _load_dotenv_file(env_file)
            field_names = getattr(self.__class__, "model_fields", {}) or {}
            for fname in field_names:
                if fname in data:
                    continue
                if fname in env_map:
                    data[fname] = env_map[fname]
                    continue
                for candidate in (fname.upper(), fname.lower()):
                    val = os.environ.get(candidate)
                    if val is not None:
                        data[fname] = val
                        break
            try:
                super().__init__(**data)
            except ValidationError:
                raise

# --- Try optional heavy imports; if missing, set to None and log ---
_optional_import_warnings = []

# Torch (optional but commonly present)
try:
    import torch
except Exception as e:
    torch = None
    _optional_import_warnings.append(f"torch missing: {e}")

# transformers pipeline (optional)
try:
    from transformers import pipeline
except Exception as e:
    pipeline = None
    _optional_import_warnings.append(f"transformers missing: {e}")

# sentence_transformers (optional)
try:
    from sentence_transformers import SentenceTransformer, util
except Exception as e:
    SentenceTransformer = None
    util = None
    _optional_import_warnings.append(f"sentence-transformers missing: {e}")

# sklearn (optional)
try:
    from sklearn.cluster import HDBSCAN
    from sklearn.decomposition import PCA
except Exception as e:
    HDBSCAN = None
    PCA = None
    _optional_import_warnings.append(f"sklearn missing: {e}")

# PyAV (video handling) - optional
try:
    import av
except Exception as e:
    av = None
    _optional_import_warnings.append(f"av (PyAV) missing: {e}")

# torchvision (vision model) - optional
try:
    from torchvision import transforms
    from torchvision.models import resnet18
except Exception as e:
    transforms = None
    resnet18 = None
    _optional_import_warnings.append(f"torchvision missing: {e}")

# sentence-transformers util and cos_sim alias if available
try:
    from sentence_transformers.util import cos_sim
except Exception:
    cos_sim = None

# aiohttp (network) - preferred for async fetching
try:
    import aiohttp
except Exception as e:
    aiohttp = None
    _optional_import_warnings.append(f"aiohttp missing: {e}")

# redis (async) optional
try:
    from redis import asyncio as aioredis
except Exception as e:
    aioredis = None
    _optional_import_warnings.append(f"aioredis missing: {e}")

# orjson optional fallback to json
try:
    import orjson
except Exception:
    orjson = None

# PIL & imagehash optional
try:
    from PIL import Image
    import imagehash
except Exception as e:
    Image = None
    imagehash = None
    _optional_import_warnings.append(f"Pillow/imagehash missing: {e}")

# loguru optional fallback to std logging
try:
    from loguru import logger
except Exception:
    import logging as _logging
    logger = _logging.getLogger("sentinel")
    logger.setLevel(_logging.INFO)
    if not logger.handlers:
        ch = _logging.StreamHandler()
        ch.setFormatter(_logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(ch)

# --- Settings ---
class Settings(BaseSettings):
    server_host: str = "127.0.0.1"
    server_port: int = 8000
    log_level: str = "INFO"
    debug: bool = False

    database_url: str = "sqlite+aiosqlite:///./data/sentinel_v5.db"
    redis_url: str = "redis://localhost:6379/0"

    shield_llm_model: str = "distilbert-base-uncased-finetuned-sst-2-english"
    shield_classifier_model: str = "facebook/bart-large-mnli"

    echo_narrative_model: str = "all-mpnet-base-v2"
    media_hash_size: int = 32

    text_chunk_size: int = 4000
    media_cache_ttl_seconds: int = 7200

    model_config = {
        "env_file": "sentinel.env",
        "env_file_encoding": "utf-8",
        "extra": "allow",
    }

settings = Settings()

# Map some legacy env vars if present (backwards compatibility)
_env = os.environ
if _env.get("HUGGINGFACE_TOKEN") or _env.get("HF_TOKEN"):
    setattr(settings, "hf_token", _env.get("HUGGINGFACE_TOKEN") or _env.get("HF_TOKEN"))
if _env.get("HF_MODEL_SENTIMENT"):
    setattr(settings, "shield_llm_model", _env.get("HF_MODEL_SENTIMENT"))
if _env.get("BACKEND_PORT"):
    try:
        settings.server_port = int(_env.get("BACKEND_PORT"))
    except Exception:
        pass

# log optional import warnings
for w in _optional_import_warnings:
    logger.warning(w)

# Ensure dirs
os.makedirs("data", exist_ok=True)
os.makedirs("static", exist_ok=True)
os.makedirs("logs", exist_ok=True)

# Database and cache placeholders
engine = None
async_session_factory = None
redis_client = None

# --- Minimal helper utilities ---
def _serialize(obj: Any) -> str:
    if orjson:
        return orjson.dumps(obj).decode("utf-8") if not isinstance(obj, (bytes, str)) else (obj if isinstance(obj, str) else obj.decode("utf-8"))
    return json.dumps(obj, default=str)

def compute_content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

# --- FastAPI app & lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine, async_session_factory, redis_client
    logger.info("Starting Project Sentinel Core (dev mode)...")

    # initialize DB (lazy) - we try to create simple sqlite file using SQLAlchemy if available
    try:
        from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
        from sqlalchemy.orm import sessionmaker, declarative_base
        from sqlalchemy import Column, String, Text, DateTime, Integer
        Base = declarative_base()
        class TextAnalysisCache(Base):
            __tablename__ = "text_analysis_cache"
            content_hash = Column(String, primary_key=True)
            result = Column(Text)
            created_at = Column(DateTime)
            expires_at = Column(DateTime)
        engine = create_async_engine(settings.database_url, echo=False, future=True)
        async_session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database initialized.")
    except Exception as e:
        logger.warning(f"SQLAlchemy/database not available or failed to initialize: {e}")

    # Redis (optional)
    if aioredis:
        try:
            redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await redis_client.ping()
            logger.info("Redis initialized.")
        except Exception as e:
            logger.warning(f"Redis unavailable: {e}")
            redis_client = None
    else:
        redis_client = None

    # load lightweight models if available (we attempt, but failures won't crash)
    try:
        await _maybe_load_models()
    except Exception as e:
        logger.warning(f"Model loading failed in lifespan: {e}")

    yield

    # shutdown cleanup
    if engine:
        await engine.dispose()
    if redis_client:
        try:
            await redis_client.close()
        except Exception:
            pass
    logger.info("Shutting down Project Sentinel Core.")

app = FastAPI(title="Project Sentinel Core (dev)", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1", "chrome-extension://*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Optional model loader (best-effort) ---
shield_llm_pipeline = None
shield_classifier_pipeline = None
narrative_model = None
vision_model = None
vision_transform = None

async def _maybe_load_models():
    global shield_llm_pipeline, shield_classifier_pipeline, narrative_model, vision_model, vision_transform
    # Transformers pipeline
    if pipeline is None:
        logger.warning("transformers.pipeline unavailable; text LLM/classifier endpoints will return 501.")
    else:
        try:
            shield_llm_pipeline = pipeline("text-classification", model=settings.shield_llm_model)
            shield_classifier_pipeline = pipeline("zero-shot-classification", model=settings.shield_classifier_model)
            logger.info("Loaded text classification and zero-shot models.")
        except Exception as e:
            logger.warning(f"Failed to load transformers models: {e}")
            shield_llm_pipeline = None
            shield_classifier_pipeline = None

    # sentence-transformers
    if SentenceTransformer is None:
        logger.warning("sentence-transformers missing; narrative analysis unavailable.")
    else:
        try:
            narrative_model = SentenceTransformer(settings.echo_narrative_model)
            logger.info("Loaded narrative embedding model.")
        except Exception as e:
            logger.warning(f"Failed to load narrative model: {e}")
            narrative_model = None

    # vision model
    if resnet18 is None or transforms is None:
        logger.warning("vision stack missing; video/frame analysis unavailable.")
    else:
        try:
            vision_model = resnet18(pretrained=True)
            vision_model.eval()
            vision_transform = transforms.Compose([
                transforms.Resize(256),
                transforms.CenterCrop(224),
                transforms.ToTensor(),
            ])
            logger.info("Loaded vision model.")
        except Exception as e:
            logger.warning(f"Failed to load vision model: {e}")
            vision_model = None
            vision_transform = None

# --- Endpoints ---
@app.get("/")
async def root():
    return HTMLResponse("<h1>Project Sentinel Core (dev)</h1><p>/api/v1/health for status</p>")

@app.get("/api/v1/health")
async def health():
    return {
        "ok": True,
        "models": {
            "shield_llm": bool(shield_llm_pipeline),
            "shield_classifier": bool(shield_classifier_pipeline),
            "narrative_model": bool(narrative_model),
            "vision_model": bool(vision_model),
        },
        "optional_libs_missing": [w for w in _optional_import_warnings],
        "timestamp": datetime.utcnow().isoformat(),
    }

# Text analysis endpoint (uses lightweight pipelines if available)
from pydantic import BaseModel as PydBaseModel

class TextReq(PydBaseModel):
    text: str

@app.post("/api/v1/analyze_text")
async def analyze_text(req: TextReq):
    text = req.text
    if shield_llm_pipeline is None and shield_classifier_pipeline is None:
        raise HTTPException(status_code=501, detail="NLP models not available (install transformers).")

    # If we have text classification pipeline, use it for quick sentiment-like output
    result = {"alerts": [], "summary": "", "emotional_score": 0.5, "manipulation_score": 0.5}
    try:
        if shield_llm_pipeline:
            out = shield_llm_pipeline(text[:512])
            result["summary"] = str(out)
        if shield_classifier_pipeline:
            labels = ["Politics", "Health", "Science", "Technology"]
            clf = shield_classifier_pipeline(text[:512], candidate_labels=labels)
            result["topics"] = clf.get("labels", [])[:3]
    except Exception as e:
        logger.warning(f"Quick analysis failed: {e}")
        raise HTTPException(status_code=500, detail="Analysis failed.")

    return result

# Media verification endpoint
class MediaReq(PydBaseModel):
    media_url: str
    media_type: Optional[str] = "image"
    stream: Optional[bool] = False

@app.post("/api/v1/verify_media")
async def verify_media(req: MediaReq):
    # If PyAV missing and video requested -> 501
    if req.media_type == "video" and av is None:
        raise HTTPException(status_code=501, detail="Video analysis requires PyAV (install 'av').")

    # For images: do a quick fetch using aiohttp if available, else error
    if aiohttp is None:
        raise HTTPException(status_code=501, detail="aiohttp required to fetch media (install 'aiohttp').")

    # Fetch content
    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(req.media_url) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=502, detail="Could not fetch media")
                data = await resp.read()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Fetch failed: {e}")

    # simple perceptual hash if PIL and imagehash available
    if Image is None or imagehash is None:
        return {"status": "yellow", "message": "Media fetched but image libraries missing (Pillow/imagehash)", "hash": compute_content_hash(data)}

    try:
        ph = imagehash.phash(Image.open(io := __import__("io").BytesIO(data)))
        return {"status": "yellow", "message": "Media analyzed (phash computed)", "hash": str(ph)}
    except Exception as e:
        logger.warning(f"Image analysis failed: {e}")
        return {"status": "yellow", "message": "Could not analyze image", "hash": compute_content_hash(data)}

# WebSocket for video analysis - will refuse gracefully if av missing
@app.websocket("/ws/video_analysis")
async def ws_video_analysis(websocket: WebSocket):
    await websocket.accept()
    params = websocket.scope.get("query_string", b"").decode()
    qs = dict(p.split("=") for p in params.split("&") if "=" in p)
    url = qs.get("url")
    if not url:
        await websocket.send_json({"error":"missing url parameter"})
        await websocket.close()
        return
    if av is None:
        await websocket.send_json({"error":"PyAV not installed; video analysis unavailable"})
        await websocket.close()
        return
    # Very naive: stream video bytes and send frame counts
    try:
        # fetch remote bytes with aiohttp
        if aiohttp is None:
            await websocket.send_json({"error":"aiohttp required to fetch video"})
            await websocket.close()
            return
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                data = await resp.read()
        container = av.open(__import__("io").BytesIO(data))
        count = 0
        for frame in container.decode(video=0):
            count += 1
            if count % 30 == 0:
                await websocket.send_json({"frame_count": count})
        await websocket.send_json({"complete": True, "frames": count})
    except Exception as e:
        await websocket.send_json({"error": str(e)})
    finally:
        await websocket.close()

# Narrative endpoint (requires sentence-transformers)
class SitesReq(PydBaseModel):
    sites: List[Dict[str, Any]]

@app.post("/api/v1/echo/narrative")
async def echo_narrative(req: SitesReq):
    if SentenceTransformer is None:
        raise HTTPException(status_code=501, detail="sentence-transformers not installed.")
    if PCA is None or HDBSCAN is None:
        raise HTTPException(status_code=501, detail="sklearn (PCA/HDBSCAN) required for clustering.")
    try:
        titles = [s.get("title","") for s in req.sites]
        em = narrative_model.encode(titles, convert_to_tensor=True)
        # simple clustering path (works if HDBSCAN available)
        import numpy as np
        emb_np = em.cpu().numpy() if hasattr(em, "cpu") else np.array(em)
        if emb_np.shape[0] > settings.media_hash_size:
            from sklearn.decomposition import PCA as _PCA
            p = _PCA(n_components=min(50, emb_np.shape[1]))
            emb_np = p.fit_transform(emb_np)
        clusterer = HDBSCAN(min_cluster_size=2)
        labels = clusterer.fit_predict(emb_np)
        clusters = {}
        for i, lab in enumerate(labels):
            if lab == -1:
                continue
            clusters.setdefault(str(lab), []).append(req.sites[i])
        return {"clusters": clusters, "topics": {}, "diversity_score": len(clusters)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Generic exception handlers
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": exc.errors()})

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

# Run
if __name__ == "__main__":
    uvicorn.run("main:app", host=settings.server_host, port=settings.server_port, reload=True, log_level="info")
