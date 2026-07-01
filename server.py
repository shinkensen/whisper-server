"""
Voice Transcription Server — faster-whisper + FastAPI
Lightweight design for low-RAM environments (1GB RAM + 2GB swap)

Endpoints:
  POST /transcribe  — upload an audio file, get text back
  GET  /health      — simple health check
  GET  /models      — list loaded model info
"""

import os
import tempfile
import logging
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

# ── Configuration (override via env vars) ───────────────────────────────────
MODEL_SIZE   = os.getenv("WHISPER_MODEL", "base")        # tiny|base|small|medium|large-v2
DEVICE       = os.getenv("WHISPER_DEVICE", "cpu")         # cpu or cuda
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")       # int8 (best for CPU/RAM-constrained)
BEAM_SIZE    = int(os.getenv("WHISPER_BEAM", "1"))        # lower = faster, less RAM
MAX_FILE_MB  = int(os.getenv("MAX_FILE_MB", "50"))        # max upload size in MB
PORT         = int(os.getenv("PORT", "8000"))

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whisper-server")

# ── App & Model ─────────────────────────────────────────────────────────────
app = FastAPI(title="Whisper Transcription Server", version="1.0.0")

model: WhisperModel | None = None


@app.on_event("startup")
def load_model():
    global model
    log.info("Loading faster-whisper model='%s' device='%s' compute='%s' …", MODEL_SIZE, DEVICE, COMPUTE_TYPE)
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    log.info("Model loaded ✓")


# ── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}


@app.get("/models")
def models():
    return {
        "loaded_model": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "beam_size": BEAM_SIZE,
        "available_sizes": ["tiny", "base", "small", "medium", "large-v2", "large-v3"],
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Query(None, description="Language code, e.g. 'en', 'es'. Auto-detected if omitted."),
    beam_size: int | None = Query(None, description="Override default beam size."),
):
    """
    Accept an audio/video file and return the transcription.

    Supported formats: anything ffmpeg can decode (mp3, wav, m4a, flac, ogg, webm, mp4 …)
    """
    if model is None:
        raise HTTPException(503, "Model not loaded yet — try again shortly.")

    # ── Size guard ──────────────────────────────────────────────────────────
    contents = await file.read()
    if len(contents) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(413, f"File too large ({len(contents)/(1024*1024):.1f} MB). Limit {MAX_FILE_MB} MB.")

    # ── Write to temp file (faster-whisper needs a path) ────────────────────
    suffix = Path(file.filename or "audio").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        log.info("Transcribing '%s' (%.1f KB) lang=%s …", file.filename, len(contents)/1024, language)

        segments_iter, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=beam_size or BEAM_SIZE,
            vad_filter=True,            # voice-activity detection — skips silence, saves RAM/time
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
            ),
        )

        # Collect segments (generator — already memory-friendly)
        segments = []
        for seg in segments_iter:
            segments.append({
                "start": round(seg.start, 2),
                "end":   round(seg.end, 2),
                "text":  seg.text.strip(),
            })

        full_text = " ".join(s["text"] for s in segments)

        log.info("Done — %d segments, %.1fs audio detected", len(segments), info.duration)

        return JSONResponse({
            "text": full_text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
            "segments": segments,
        })

    except Exception as exc:
        log.exception("Transcription failed")
        raise HTTPException(500, f"Transcription error: {exc}")

    finally:
        # Always clean up the temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Run directly ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")