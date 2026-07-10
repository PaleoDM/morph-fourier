#!/usr/bin/env bash
# Morph-Fourier — one-time setup script
# Creates the Python venv for the backend, installs Python + Node deps,
# downloads the SAM model. Safe to re-run: reuses existing installs.

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "============================================="
echo "  Morph-Fourier — Setup"
echo "============================================="
echo "App dir: $APP_DIR"
echo

# --- Python for backend ---
echo "[1/4] Setting up backend Python environment ..."
PY_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        major=$("$candidate" -c 'import sys; print(sys.version_info[0])' 2>/dev/null || echo 0)
        minor=$("$candidate" -c 'import sys; print(sys.version_info[1])' 2>/dev/null || echo 0)
        if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ] && [ "$minor" -le 13 ]; then
            PY_BIN="$candidate"
            break
        fi
    fi
done
if [ -z "$PY_BIN" ]; then
    echo "❌ ERROR: Need Python 3.10, 3.11, 3.12, or 3.13."
    echo "   Install from https://www.python.org/downloads/release/python-3135/"
    exit 1
fi
echo "   Using $PY_BIN ($($PY_BIN --version 2>&1))"

if [ ! -d "backend/.venv" ]; then
    "$PY_BIN" -m venv backend/.venv
fi
# shellcheck source=/dev/null
source backend/.venv/bin/activate
python -m pip install --upgrade pip --quiet
pip install -r backend/requirements.txt --quiet
echo "   ✓ Backend Python deps installed."

# --- SAM weights ---
echo
echo "[2/4] SAM ViT-B weights ..."
WEIGHTS_DIR="backend/models"
WEIGHTS_FILE="$WEIGHTS_DIR/sam_vit_b_01ec64.pth"
WEIGHTS_URL="https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"
EXPECTED_BYTES=375042383
mkdir -p "$WEIGHTS_DIR"
if [ -f "$WEIGHTS_FILE" ] && [ "$(wc -c < "$WEIGHTS_FILE" | tr -d ' ')" = "$EXPECTED_BYTES" ]; then
    echo "   ✓ Already present."
else
    echo "   Downloading (~375 MB) ..."
    curl -L --progress-bar -o "$WEIGHTS_FILE" "$WEIGHTS_URL"
fi

# --- Node for frontend ---
echo
echo "[3/4] Setting up frontend Node environment ..."
if ! command -v node >/dev/null 2>&1; then
    echo "❌ ERROR: Node.js not installed. Install from https://nodejs.org/ (LTS)."
    exit 1
fi
echo "   Using node $(node --version), npm $(npm --version)"
cd frontend
npm install --silent
cd ..
echo "   ✓ Frontend Node deps installed."

# --- Import sanity check ---
echo
echo "[4/4] Verifying imports ..."
python -c "import fastapi, torch, numpy, cv2, skimage, segment_anything, PIL, pyefd, sklearn; print('   ✓ All backend imports OK.')" || {
    echo "❌ Backend import verification failed."
    exit 1
}
(cd frontend && node -e "require('react'); require('react-dom'); console.log('   ✓ Frontend imports OK.')") || {
    echo "❌ Frontend import verification failed."
    exit 1
}

echo
echo "============================================="
echo "  ✅ Setup complete!"
echo "============================================="
echo
echo "Next: ./run-dev.command    (starts frontend + backend dev servers)"
echo "Or:   ./run-prod.command   (builds frontend, serves everything on :8000)"
