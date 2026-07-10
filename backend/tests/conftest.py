"""Test bootstrap: make the backend package importable as ``app.*``.

Tests import the ported modules as ``app.analysis`` etc. by putting
``backend/src`` on ``sys.path``. ``test_parity`` additionally imports the frozen
hyoid modules live as the golden reference (it adds ``apps/hyoids/src`` itself).
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent  # apps/morph-fourier/backend/
SRC = BACKEND_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def pytest_configure(config):
    """Register custom markers so ``-W error`` / strict-marker runs stay clean."""
    config.addinivalue_line(
        "markers",
        "needs_sam: test requires the SAM weights file; skips cleanly when absent.",
    )
