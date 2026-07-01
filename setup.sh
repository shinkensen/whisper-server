#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Whisper Transcription Server — Ubuntu VM Setup (Node.js)
# Run:  chmod +x setup.sh && ./setup.sh
# ──────────────────────────────────────────────────────────────────────────
set -e

echo "========================================="
echo "  Whisper Server — Ubuntu VM Setup"
echo "  (Node.js + whisper.cpp)"
echo "========================================="

# ── 1. System packages ────────────────────────────────────────────────────
echo ""
echo "[1/5] Installing system dependencies …"
sudo apt-get update -qq
sudo apt-get install -y -qq \
    ffmpeg \
    git build-essential

# ── 2. Node.js ─────────────────────────────────────────────────────────────
if command -v node &>/dev/null && [ "$(node -v | cut -d. -f1 | tr -d 'v')" -ge 18 ]; then
    echo ""
    echo "[2/5] Node.js $(node -v) already installed ✓"
else
    echo ""
    echo "[2/5] Installing Node.js 20 LTS …"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
    echo "  Installed Node.js $(node -v)"
fi

# ── 3. npm install ─────────────────────────────────────────────────────────
echo ""
echo "[3/5] Installing npm dependencies (whisper.cpp will compile on first run) …"
npm install

# ── 4. Env file ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    echo ""
    echo "[4/5] Creating .env from .env.example …"
    cp .env.example .env
else
    echo ""
    echo "[4/5] .env already exists — keeping it."
fi

# ── 5. Done ─────────────────────────────────────────────────────────────────
echo ""
echo "[5/5] ✅ Setup complete!"
echo ""
echo "─────────────────────────────────────────"
echo "  To start the server:"
echo ""
echo "    npm start"
echo ""
echo "  Test it:"
echo "    curl -F 'file=@recording.mp3' http://localhost:8000/transcribe"
echo ""
echo "  Note: First transcription will take longer as"
echo "  whisper.cpp compiles and downloads the model."
echo "─────────────────────────────────────────"