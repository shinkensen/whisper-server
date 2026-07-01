# 🎙️ Whisper Transcription Server

Lightweight voice transcription server built with **Express.js** + **whisper.cpp** (via `whisper-node`).
Designed to run on low-resource VMs (1 GB RAM + 2 GB swap).

---

## Quick Start (Ubuntu VM)

```bash
# 1. Clone / copy the project files to your VM
# 2. Run the setup script
chmod +x setup.sh
./setup.sh

# 3. Start the server
npm start
```

The server starts on `http://0.0.0.0:8000`.

> **Note:** The first transcription request will take longer because whisper.cpp compiles from source and downloads the model. Subsequent requests will be fast.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/models` | Show model info |
| `POST` | `/transcribe` | Upload audio → get text |

### Transcribe

```bash
# Basic — auto-detect language
curl -F "file=@my_voice_note.mp3" http://localhost:8000/transcribe

# Specify language (faster, more accurate)
curl -F "file=@recording.wav" "http://localhost:8000/transcribe?language=en"

# Override beam size (higher = more accurate but slower)
curl -F "file=@meeting.m4a" "http://localhost:8000/transcribe?beam_size=3"
```

**Response:**

```json
{
  "text": "Hello, this is my voice note transcription.",
  "language": "en",
  "duration": 5.42,
  "segments": [
    { "start": 0.0, "end": 5.42, "text": "Hello, this is my voice note transcription." }
  ]
}
```

### Supported Audio Formats

Anything `ffmpeg` handles: `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.webm`, `.mp4`, etc.
The server automatically converts all uploads to 16kHz mono WAV for whisper.cpp.

---

## Configuration

Environment variables (set in `.env` or export directly):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL` | `base` | Model size: `tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3` |
| `WHISPER_LANGUAGE` | `auto` | Language code (e.g. `en`, `es`) or `auto` to detect |
| `MAX_FILE_MB` | `50` | Max upload size in MB |
| `PORT` | `8000` | Server port |

### Model Size vs RAM Guide

| Model | RAM Usage | Speed | Accuracy |
|-------|-----------|-------|----------|
| `tiny` | ~80 MB | ⚡⚡⚡ | Decent |
| `base` | ~150 MB | ⚡⚡ | Good ← **recommended for 1GB RAM** |
| `small` | ~500 MB | ⚡ | Very good |
| `medium` | ~1.5 GB | 🐢 | Great (may swap) |
| `large-v3` | ~3 GB | 🐌🐌 | Best (will swap heavily) |

> **Tip:** Stick with `base` on 1GB RAM. The model downloads once and caches in `node_modules/whisper-node/`.

---

## Running as a Background Service

Create a systemd service so it starts on boot:

```bash
sudo tee /etc/systemd/system/whisper-server.service <<EOF
[Unit]
Description=Whisper Transcription Server
After=network.target

[Service]
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$(pwd)/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now whisper-server
sudo systemctl status whisper-server
```

---

## Memory Tips for 1GB RAM

1. **Use `base` model** — it fits comfortably in RAM with room for the server.
2. **Keep `beam_size=1`** — beam search is the biggest RAM hog during transcription.
3. **All audio is resampled to 16kHz mono** — smaller data = less memory to process.
4. **Avoid concurrent requests** — one transcription at a time keeps memory predictable.
5. **If you get OOM kills**, try `tiny` model or increase swap:
   ```bash
   sudo fallocate -l 4G /swapfile2
   sudo chmod 600 /swapfile2
   sudo mkswap /swapfile2
   sudo swapon /swapfile2
   echo '/swapfile2 none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

---

## How It Works

1. **Upload** — You POST an audio file (any format ffmpeg supports)
2. **Convert** — Server resamples to 16kHz mono 16-bit WAV (required by whisper.cpp)
3. **Transcribe** — whisper.cpp processes the audio and returns timestamped segments
4. **Clean up** — Temp files are deleted after every request

The server uses `whisper-node` which bundles **whisper.cpp** — a C/C++ implementation of OpenAI's Whisper that's significantly faster and lighter on memory than the Python version.