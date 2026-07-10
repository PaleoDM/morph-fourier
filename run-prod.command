#!/usr/bin/env bash
# Morph-Fourier — production mode
# Builds the frontend, then starts uvicorn which serves both the API
# (/api/*) and the built React bundle (/) on port 8000.
# Single process, one browser tab.

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

if [ ! -d "backend/.venv" ] || [ ! -d "frontend/node_modules" ]; then
    echo "❌ Setup hasn't run yet. Run ./setup.command first."
    exit 1
fi

echo "Building frontend ..."
cd frontend
npm run build
cd ..

echo
echo "============================================="
echo "  Morph-Fourier — production mode"
echo "============================================="
echo "  App:  http://localhost:8000  ← open this in your browser"
echo "  Press Ctrl-C to stop."
echo "============================================="
echo

# shellcheck source=/dev/null
source backend/.venv/bin/activate
cd backend
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir src
