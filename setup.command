#!/usr/bin/env bash
# Morph-Fourier — one-time setup (macOS).
# Creates the Python venv, installs dependencies, downloads the SAM model, and
# BUILDS the frontend so that launching later needs no Node. Safe to re-run.

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "============================================="
echo "  Morph-Fourier — Setup"
echo "============================================="
echo "App dir: $APP_DIR"
echo

# --- [1/4] Python for the backend ---
echo "[1/4] Backend Python environment ..."
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
    echo "   Install from https://www.python.org/downloads/"
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
echo "   ✓ Backend dependencies installed."

# --- [2/4] SAM weights ---
echo
echo "[2/4] Segment Anything model weights ..."
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

# --- [3/4] Frontend — build it now so the app runs without Node later ---
echo
echo "[3/4] Frontend ..."
if command -v node >/dev/null 2>&1; then
    echo "   Using node $(node --version), npm $(npm --version)"
    (cd frontend && npm install --silent && npm run build >/dev/null)
    echo "   ✓ Frontend built."
elif [ -f frontend/dist/index.html ]; then
    echo "   ✓ Node not found, but a pre-built frontend is bundled — using it."
else
    echo "❌ ERROR: Node.js is not installed and no pre-built frontend was found."
    echo "   Install Node LTS from https://nodejs.org/ and re-run this script."
    exit 1
fi

# --- [4/4] Verify ---
echo
echo "[4/4] Verifying ..."
python -c "import fastapi, torch, numpy, cv2, skimage, segment_anything, PIL, pyefd, sklearn" \
    && echo "   ✓ Backend imports OK." \
    || { echo "❌ Backend import verification failed."; exit 1; }
if [ -f frontend/dist/index.html ]; then
    echo "   ✓ Frontend bundle present."
else
    echo "❌ Frontend bundle missing (frontend/dist)."; exit 1
fi

# --- Build the click-to-launch app (runs with no visible terminal) ---
echo
echo "[+] Building the Morph-Fourier app ..."
if command -v osacompile >/dev/null 2>&1 && [ -f launcher.applescript ]; then
    rm -rf "Morph-Fourier.app"
    if osacompile -o "Morph-Fourier.app" launcher.applescript >/dev/null 2>&1; then
        echo "   ✓ Built Morph-Fourier.app."
    else
        echo "   (Couldn't build the app wrapper — run-prod.command still works.)"
    fi
else
    echo "   (Skipped — run-prod.command still works.)"
fi

echo
echo "============================================="
echo "  ✅ Setup complete!"
echo "============================================="
echo
echo "To launch, double-click  Morph-Fourier.app  — it opens in your browser"
echo "with no terminal window. (Quit the app from the Dock to stop the server.)"
echo "The plain  run-prod.command  still works too."
