/**
 * Voice Transcription Server — Express + whisper.cpp (direct binary call)
 * Lightweight design for low-RAM environments (1GB RAM + 2GB swap)
 *
 * NOTE: This version bypasses the `whisper-node` npm wrapper and calls the
 * compiled whisper.cpp `main` binary directly. The wrapper was silently
 * failing to forward options (e.g. beam_size) and failing to parse output
 * correctly, resulting in "0 segments" even when whisper.cpp transcribed
 * successfully. We still reuse the binary + models that `whisper-node`
 * downloaded/compiled into node_modules, we just talk to them ourselves.
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
const { execFile, execSync } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

// ── Configuration (override via env vars) ───────────────────────────────────
const MODEL_SIZE = process.env.WHISPER_MODEL || "small"; // tiny|base|small|medium|large-v2|large-v3
const LANGUAGE = process.env.WHISPER_LANGUAGE || "auto"; // language code or "auto"
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "50", 10);
const PORT = parseInt(process.env.PORT || "8000", 10);
const CPU_THREADS = parseInt(
  process.env.WHISPER_THREADS || os.cpus().length,
  10
);
// ── whisper.cpp binary/model locations (reusing what whisper-node set up) ───
const WHISPER_CPP_DIR = path.join(
  __dirname,
  "node_modules",
  "whisper-node",
  "lib",
  "whisper.cpp"
);
const WHISPER_BIN = path.join(WHISPER_CPP_DIR, "main");

function modelPathFor(modelSize) {
  return path.join(WHISPER_CPP_DIR, "models", `ggml-${modelSize}.bin`);
}

// ── Multer setup (temp file storage) ─────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

let modelLoaded = false;

// ── Verify binary + model exist on startup ───────────────────────────────────
async function initModel() {
  console.log(`[INFO] Checking whisper.cpp binary and model='${MODEL_SIZE}'…`);
  try {
    if (!fs.existsSync(WHISPER_BIN)) {
      throw new Error(`whisper.cpp binary not found at ${WHISPER_BIN}`);
    }
    const modelPath = modelPathFor(MODEL_SIZE);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}`);
    }
    console.log(`[INFO] Binary: ${WHISPER_BIN}`);
    console.log(`[INFO] Model:  ${modelPath}`);
    modelLoaded = true;
  } catch (err) {
    console.error("[ERROR] Failed to initialize whisper model:", err.message);
    process.exit(1);
  }
}

// ── whisper.cpp runner ────────────────────────────────────────────────────────

function parseWhisperOutput(stdout) {
  // Matches lines like: [00:00:00.000 --> 00:00:04.880]   text here
  const lineRe = /\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)/;
  const toSeconds = (ts) => {
    const [h, m, s] = ts.split(":");
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
  };

  const segments = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(lineRe);
    if (match) {
      segments.push({
        start: toSeconds(match[1]),
        end: toSeconds(match[2]),
        text: match[3].trim(),
      });
    }
  }
  return segments;
}

async function runWhisperCpp(wavPath, { language, beamSize } = {}) {
  const args = [
    "-m", modelPathFor(MODEL_SIZE),
    "-f", wavPath,

    "-t", String(CPU_THREADS),   // <-- all cores
    "-bs", String(beamSize),

    "-l", language && language !== "auto"
        ? language
        : "auto",
];

  const { stdout } = await execFileAsync(WHISPER_BIN, args, {
    cwd: WHISPER_CPP_DIR,
    maxBuffer: 1024 * 1024 * 20, // 20MB, generous headroom for long transcripts
  });

  return parseWhisperOutput(stdout);
}

// ── Endpoints ───────────────────────────────────────────────────────────────

app.get("/health",(req,res)=>{

res.json({

status:"ok",

model:MODEL_SIZE,

threads:CPU_THREADS,

memory:process.memoryUsage(),

uptime:process.uptime(),

cpu:os.loadavg(),

cores:os.cpus().length

});

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

  // whisper.cpp expects WAV (16kHz, 16-bit, mono). Convert/resample via ffmpeg.
  const ext = path.extname(originalName).toLowerCase();
  const isWav = ext === ".wav";
  let whisperInput = tmpPath;
  const wavPath = isWav ? tmpPath + "_resampled.wav" : tmpPath + ".wav";

  try {
    console.log(
      `[INFO] ${isWav ? "Resampling" : "Converting"} '${originalName}' to WAV (16kHz mono 16-bit)…`
    );
    execSync(
      `ffmpeg -threads ${CPU_THREADS} -y -i "${tmpPath}" -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}"`
    );
    whisperInput = wavPath;
  } catch (convErr) {
    cleanup(tmpPath, wavPath);
    return res.status(400).json({
      error: `Failed to ${isWav ? "resample" : "convert"} audio to WAV. Is ffmpeg installed? ${convErr.message}`,
    });
  }

  try {
    const langParam = req.query.language || (LANGUAGE !== "auto" ? LANGUAGE : undefined);
    const beamSize = parseInt("5", 10);

    console.log(
      `[INFO] Transcribing '${originalName}' lang=${langParam || "auto"} beam=${beamSize}…`
    );

    const segments = await runWhisperCpp(whisperInput, {
      language: langParam,
      beamSize,
    });

    if (!segments.length) {
      throw new Error(
        "Whisper produced no transcribable speech (empty or silent audio)."
      );
    }

    const fullText = segments.map((s) => s.text).join(" ");
    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

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