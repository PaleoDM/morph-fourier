#!/usr/bin/env bash
# Morph-Fourier — development mode
# Starts backend on :8000 and frontend on :5173 in parallel.
# Vite proxies /api/* and /photos/* from :5173 → :8000.
# Ctrl-C stops both.

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

if [ ! -d "backend/.venv" ] || [ ! -d "frontend/node_modules" ]; then
    echo "❌ Setup hasn't run yet. Run ./setup.command first."
    exit 1
fi

echo "============================================="
echo "  Morph-Fourier — dev mode"
echo "============================================="
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173  ← open this in your browser"
echo "  Press Ctrl-C to stop both."
echo "============================================="
echo

# Start backend in background, forward its output.
# shellcheck source=/dev/null
source backend/.venv/bin/activate
cd backend
uvicorn app.main:app --reload --port 8000 --app-dir src &
BACKEND_PID=$!
cd ..

# Kill backend when script exits
trap "kill $BACKEND_PID 2>/dev/null || true" EXIT INT TERM

# Frontend in foreground so Ctrl-C hits both
cd frontend
npm run dev
