#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Whisper Transcription Server — Ubuntu VM Setup
# Run:  chmod +x setup.sh && ./setup.sh
# ──────────────────────────────────────────────────────────────────────────
set -e

echo "========================================="
echo "  Whisper Server — Ubuntu VM Setup"
echo "========================================="

# ── 1. System packages ────────────────────────────────────────────────────
echo ""
echo "[1/5] Installing system dependencies …"
sudo apt-get update -qq
sudo apt-get install -y -qq \
    python3 python3-pip python3-venv \
    ffmpeg \
    git build-essential

# ── 2. Python venv ─────────────────────────────────────────────────────────
echo ""
echo "[2/5] Creating Python virtual environment …"
python3 -m venv venv
source venv/bin/activate

# ── 3. Python packages ─────────────────────────────────────────────────────
echo ""
echo "[3/5] Installing Python dependencies (this may take a minute) …"
pip install --upgrade pip
pip install -r requirements.txt

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
echo "    source venv/bin/activate"
echo "    python server.py"
echo ""
echo "  Or with dotenv auto-load:"
echo "    pip install python-dotenv  # optional"
echo "    python server.py"
echo ""
echo "  Test it:"
echo "    curl -F 'file=@recording.mp3' http://localhost:8000/transcribe"
echo "─────────────────────────────────────────"