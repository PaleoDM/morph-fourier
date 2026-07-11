#!/usr/bin/env bash
# Morph-Fourier — launch (macOS). Double-click this.
# Runs setup automatically on first launch, serves the app on :8000, and opens
# your browser. uvicorn serves both the API (/api/*) and the built React bundle.

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

# First launch (or an incomplete install) — set up automatically.
if [ ! -x backend/.venv/bin/python ] || [ ! -f frontend/dist/index.html ]; then
    echo "First launch — running setup (this can take a few minutes) ..."
    ./setup.command
    echo
fi

echo "============================================="
echo "  Morph-Fourier"
echo "============================================="
echo "  Opening http://localhost:8000 in your browser ..."
echo "  Keep this window open while you work. Press Ctrl-C to quit."
echo "============================================="
echo

# Open the browser once the server is actually accepting connections. Runs in the
# background; the server itself stays in the foreground (below).
(
    for _ in $(seq 1 120); do
        if curl -fs -o /dev/null "http://localhost:8000/api/health"; then
            open "http://localhost:8000"
            break
        fi
        sleep 0.5
    done
) &

# shellcheck source=/dev/null
source backend/.venv/bin/activate
# `python -m uvicorn` (not the bare `uvicorn` console script) so the launcher
# keeps working even if the folder is moved after setup.
exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend/src
