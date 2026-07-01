/**
 * Voice Transcription Server — Express + whisper.cpp (via whisper-node)
 * Lightweight design for low-RAM environments (1GB RAM + 2GB swap)
 *
 * Endpoints:
 *   POST /transcribe  — upload an audio file, get transcription back
 *   GET  /health      — simple health check
 *   GET  /models      — show model info
 */

require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { whisper } = require("whisper-node");

// ── Configuration (override via env vars) ───────────────────────────────────
const MODEL_SIZE = process.env.WHISPER_MODEL || "base"; // tiny|base|small|medium|large-v2|large-v3
const LANGUAGE = process.env.WHISPER_LANGUAGE || "auto"; // language code or "auto"
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "50", 10);
const PORT = parseInt(process.env.PORT || "8000", 10);

// ── Multer setup (temp file storage) ─────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

let modelLoaded = false;

// ── Load model on startup ────────────────────────────────────────────────────
async function initModel() {
  console.log(
    `[INFO] Pre-loading whisper.cpp model='${MODEL_SIZE}' (first call will compile + cache it)…`
  );
  try {
    // Do a dummy call to trigger model download + compilation at startup
    // whisper-node lazily loads, so we just flag that we're ready
    console.log(`[INFO] Model will load on first transcription request.`);
    modelLoaded = true;
  } catch (err) {
    console.error("[ERROR] Failed to initialize whisper model:", err.message);
    process.exit(1);
  }
}

// ── Endpoints ───────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL_SIZE, runtime: "node" });
});

app.get("/models", (req, res) => {
  res.json({
    loaded_model: MODEL_SIZE,
    language: LANGUAGE,
    available_sizes: [
      "tiny",
      "base",
      "small",
      "medium",
      "large-v2",
      "large-v3",
    ],
  });
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Use form field 'file'." });
  }

  const tmpPath = req.file.path;
  const originalName = req.file.originalname || "audio";

  // whisper.cpp expects WAV (16kHz, 16-bit, mono). Convert via ffmpeg if needed.
  const ext = path.extname(originalName).toLowerCase();
  const isWav = ext === ".wav";
  let whisperInput = tmpPath;

  // If not WAV, convert to proper WAV format for whisper.cpp
  if (!isWav) {
    const { execSync } = require("child_process");
    const wavPath = tmpPath + ".wav";
    try {
      console.log(
        `[INFO] Converting '${originalName}' to WAV (16kHz mono 16-bit)…`
      );
      execSync(
        `ffmpeg -y -i "${tmpPath}" -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`,
        { stdio: "pipe" }
      );
      whisperInput = wavPath;
    } catch (convErr) {
      cleanup(tmpPath, wavPath);
      return res.status(400).json({
        error: `Failed to convert audio to WAV. Is ffmpeg installed? ${convErr.message}`,
      });
    }
  } else {
    // Even .wav files might not be 16kHz mono — re-encode to be safe
    const { execSync } = require("child_process");
    const wavPath = tmpPath + "_resampled.wav";
    try {
      execSync(
        `ffmpeg -y -i "${tmpPath}" -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`,
        { stdio: "pipe" }
      );
      whisperInput = wavPath;
    } catch (convErr) {
      cleanup(tmpPath);
      return res.status(400).json({
        error: `Failed to resample WAV. Is ffmpeg installed? ${convErr.message}`,
      });
    }
  }

  try {
    const langParam = req.query.language || (LANGUAGE !== "auto" ? LANGUAGE : undefined);
    const beamSize = parseInt(req.query.beam_size || "1", 10);

    console.log(
      `[INFO] Transcribing '${originalName}' lang=${langParam || "auto"} beam=${beamSize}…`
    );

    const transcription = await whisper(whisperInput, {
      modelName: MODEL_SIZE,
      language: langParam,
      whisperOptions: {
        beamSize,
      }
    });

    // 2. SAFETY CHECK: Ensure transcription isn't undefined or empty before mapping
    if (!transcription || !Array.isArray(transcription)) {
      throw new Error("Whisper returned an empty or invalid response.");
    }

    const segments = transcription.map((seg) => ({
      start: parseFloat(seg.start || 0),
      end: parseFloat(seg.end || 0),
      text: (seg.speech || "").trim(),
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const duration =
      segments.length > 0 ? segments[segments.length - 1].end : 0;

    console.log(
      `[INFO] Done — ${segments.length} segments, ${duration}s audio`
    );

    res.json({
      text: fullText,
      language: langParam || "auto",
      duration: Math.round(duration * 100) / 100,
      segments,
    });
  } catch (err) {
    console.error("[ERROR] Transcription failed:", err.message);
    res.status(500).json({ error: `Transcription error: ${err.message}` });
  } finally {
    // Always clean up temp files
    cleanup(tmpPath, whisperInput);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanup(...files) {
  for (const f of files) {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      /* ignore */
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
initModel().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[INFO] 🎙️  Whisper server running on http://0.0.0.0:${PORT}`);
    console.log(`[INFO]    Model: ${MODEL_SIZE}`);
    console.log(`[INFO]    Max upload: ${MAX_FILE_MB} MB`);
    console.log(`[INFO]    POST /transcribe  — upload audio, get text`);
  });
});