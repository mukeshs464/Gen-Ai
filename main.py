# main.py
import os, re, hashlib, json, time, sqlite3
from io import BytesIO
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import imagehash
import requests

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

# Hugging Face config (optional)
HF_TOKEN = os.getenv("HUGGINGFACE_TOKEN")
HF_MODEL = "distilbert-base-uncased-finetuned-sst-2-english"
HF_URL = f"https://api-inference.huggingface.co/models/{HF_MODEL}"
HF_HEADERS = {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}

# Lexicon & fallacy patterns
emotional_words = set("""
shocking outrage scandal disastrous horrific terrifying explosive alarming unbelievable corrupt evil
manipulated disgusting furious hate anger panic crisis
""".split())

fallacy_patterns = {
    "False Dilemma": r"\beither\b.*\bor\b",
    "Straw Man": r"\bso (you|you're|they're|we're) saying\b",
    "Ad Hominem": r"\b(idiot|moron|clown|stupid|dumb|crazy)\b",
}

class VerifyRequest(BaseModel):
    text: str

def hf_sentiment(text: str):
    """
    Call HF Inference API (if token available). Return normalized dict.
    If token missing or call fails, return neutral mock.
    """
    if not HF_TOKEN:
        return {"label": "NEUTRAL", "score": 0.5, "note": "HF token missing → mock neutral"}
    try:
        r = requests.post(HF_URL, headers=HF_HEADERS, json={"inputs": text[:4000]}, timeout=12)
        out = r.json()
        # Normalize possible response shapes
        candidate = None
        if isinstance(out, list):
            candidate = out[0]
            if isinstance(candidate, list):
                candidate = candidate[0]
        elif isinstance(out, dict):
            candidate = out
        if isinstance(candidate, dict) and "label" in candidate:
            return {"label": candidate.get("label", "NEUTRAL"), "score": float(candidate.get("score", 0.5))}
        return {"label": "NEUTRAL", "score": 0.5, "note": "unexpected hf response", "raw": out}
    except Exception as e:
        return {"label": "NEUTRAL", "score": 0.5, "error": str(e)}

@app.post("/verify")
def verify_text(req: VerifyRequest):
    text = req.text or ""
    lower = text.lower()

    # 1) sentiment
    sent = hf_sentiment(text)

    # 2) emotion lexicon
    found_emotions = sorted({w for w in emotional_words if w in lower})

    # 3) fallacies
    found_fallacies = []
    for name, pat in fallacy_patterns.items():
        if re.search(pat, text, re.I):
            found_fallacies.append(name)

    # 4) status
    status = "green"
    categories = []
    if found_emotions and (sent["label"] == "NEGATIVE" and sent.get("score", 0) >= 0.75):
        categories.append("Emotional manipulation")
        status = "yellow"
    if any(f in ("Straw Man", "Ad Hominem", "False Dilemma") for f in found_fallacies):
        status = "red"

    alerts = []
    if found_emotions:
        alerts.append(f"Emotional triggers: {', '.join(found_emotions)}")
    for f in found_fallacies:
        alerts.append(f"Possible {f} fallacy")

    return {
        "status": status,
        "categories": categories + found_fallacies,
        "sentiment": sent,
        "alerts": alerts
    }

# ----- Manifest (mock) -----
class ManifestRequest(BaseModel):
    content: str

@app.post("/manifest")
def manifest_upload(req: ManifestRequest):
    return {"hash": "mock12345hash"}

# ----- Genesis (image provenance) -----
DB_PATH = "genesis.db"

def db_init():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS manifests(
      id INTEGER PRIMARY KEY,
      sha256 TEXT UNIQUE,
      phash TEXT,
      source TEXT,
      signature TEXT,
      cid TEXT,
      created_at INTEGER
    )""")
    con.commit(); con.close()

db_init()

def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def sign_manifest(payload: dict) -> str:
    raw = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def pin_to_ipfs(payload: dict) -> str:
    # mock CID
    return "mockCID-" + hashlib.md5(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:10]

class ImageVerifyRequest(BaseModel):
    url: str

@app.post("/image/verify")
def image_verify(req: ImageVerifyRequest):
    try:
        r = requests.get(req.url, timeout=12)
        b = r.content
        sha = sha256_bytes(b)
        img = Image.open(BytesIO(b)).convert("RGB")
        ph = str(imagehash.phash(img))
        con = sqlite3.connect(DB_PATH); cur = con.cursor()
        cur.execute("SELECT sha256, phash, source, signature, cid FROM manifests WHERE sha256=?", (sha,))
        row = cur.fetchone()
        if row:
            status = "green"; reason = "Exact hash match in manifest registry"
            out = {"status": status, "reason": reason, "sha256": sha, "phash": ph, "source": row[2], "cid": row[4]}
            con.close(); return out

        # search for perceptual near matches
        cur.execute("SELECT sha256, phash, source, cid FROM manifests")
        near = []
        for sha2, ph2, src2, cid2 in cur.fetchall():
            try:
                dist = imagehash.hex_to_hash(ph) - imagehash.hex_to_hash(ph2)
            except Exception:
                dist = 999
            if dist <= 8:
                near.append({"sha256": sha2, "phash": ph2, "source": src2, "cid": cid2, "dist": int(dist)})

        if near:
            status = "yellow"; reason = "Perceptual near-match found (possible edit/resize)"
            con.close(); return {"status": status, "reason": reason, "sha256": sha, "phash": ph, "near": near}

        con.close()
        return {"status": "red", "reason": "No manifest match", "sha256": sha, "phash": ph}
    except Exception as e:
        return {"status": "error", "error": str(e)}

class ImageRegisterRequest(BaseModel):
    url: str
    source: str

@app.post("/image/register")
def image_register(req: ImageRegisterRequest):
    try:
        r = requests.get(req.url, timeout=12)
        b = r.content
        sha = sha256_bytes(b)
        img = Image.open(BytesIO(b)).convert("RGB")
        ph = str(imagehash.phash(img))

        manifest = {"sha256": sha, "phash": ph, "source": req.source, "created_at": int(time.time())}
        sig = sign_manifest(manifest)
        cid = pin_to_ipfs(manifest)

        con = sqlite3.connect(DB_PATH); cur = con.cursor()
        cur.execute("""INSERT OR IGNORE INTO manifests(sha256, phash, source, signature, cid, created_at)
                       VALUES(?,?,?,?,?,?)""", (sha, ph, req.source, sig, cid, manifest["created_at"]))
        con.commit(); con.close()

        return {"ok": True, "manifest": manifest, "signature": sig, "cid": cid}
    except Exception as e:
        return {"ok": False, "error": str(e)}
