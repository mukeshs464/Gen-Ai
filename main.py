from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

# Input format expected from extension
class VerifyRequest(BaseModel):
    text: str

# ✅ Mock verification endpoint
@app.post("/verify")
def verify_text(req: VerifyRequest):
    text = req.text.lower()

    alerts = []
    status = "green"

    # Simple emotional/sensational keyword detection
    if any(word in text for word in ["shocking", "outrage", "breaking", "scandal"]):
        alerts.append("Emotional trigger detected ⚠️")
        status = "yellow"

    # Simple fallacy pattern detection
    if "either" in text and "or" in text:
        alerts.append("Possible False Dilemma detected ⚠️")
        status = "red"

    return {"status": status, "alerts": alerts}

# ✅ Mock manifest upload endpoint
class ManifestRequest(BaseModel):
    content: str

@app.post("/manifest")
def manifest_upload(req: ManifestRequest):
    # Fake hash (normally you'd compute SHA256 or similar)
    return {"hash": "mock12345hash"}
