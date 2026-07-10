"""Phase 1B route smoke tests (FastAPI TestClient).

Deliberately light: health, series discovery, a state GET→PUT→GET round-trip,
photo serving 200/404, SAM gating (503 when weights absent), and — behind the
``needs_sam`` marker — a real segment producing a simplified anchor path. The
math itself is covered by the Phase 1A parity/state suites.

Each test runs against an isolated on-disk state root and a synthetic photos
root so nothing touches the real ``backend/state`` or any real dataset.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import models
from app.api import deps
from app.main import app

SERIES_DISPLAY = "Testus (View A)"
SERIES_KEY = "testus_view_a"
PHOTOS = ["Testus_species_100_1.jpg", "Testus_species_101_1.jpg"]


def _write_ellipse(path) -> None:
    """A white frame with one dark filled ellipse — SAM segments it reliably."""
    img = Image.new("RGB", (400, 300), (255, 255, 255))
    ImageDraw.Draw(img).ellipse([120, 90, 300, 220], fill=(40, 40, 40))
    img.save(path)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Isolated state root + synthetic photos root, wired via env + monkeypatch."""
    from app import state

    monkeypatch.setattr(state, "STATE_ROOT", tmp_path / "state")

    photos_root = tmp_path / "photos"
    series_dir = photos_root / SERIES_DISPLAY
    series_dir.mkdir(parents=True)
    for name in PHOTOS:
        _write_ellipse(series_dir / name)
    monkeypatch.setenv("MORPH_FOURIER_PHOTOS_ROOT", str(photos_root))

    # Reset the SAM predictor cache so gating tests are order-independent.
    monkeypatch.setattr(deps, "_sam_predictor", None)
    return tmp_path


@pytest.fixture()
def client(env):
    return TestClient(app)


def _record_key(i: int = 0) -> str:
    return f"{SERIES_KEY}/{PHOTOS[i]}"


# ---------- health & discovery ----------


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_series_list(client):
    r = client.get("/api/series")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["key"] == SERIES_KEY
    assert body[0]["displayName"] == SERIES_DISPLAY
    assert body[0]["photoCount"] == 2


def test_unknown_series_status_404(client):
    assert client.get("/api/does_not_exist/status").status_code == 404


def test_aggregate_status_shape(client):
    r = client.get(f"/api/{SERIES_KEY}/status")
    assert r.status_code == 200
    body = r.json()
    # All eight stage ids present with the StageStatus envelope.
    assert set(body.keys()) == set(deps.STAGE_IDS)
    for status in body.values():
        assert status["seriesKey"] == SERIES_KEY
        assert status["totalCanonicals"] == 0  # nothing curated yet


# ---------- photo serving ----------


def test_photo_serving_200_and_404(client):
    r = client.get(f"/photos/{SERIES_KEY}/{PHOTOS[0]}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert len(r.content) > 0

    assert client.get(f"/photos/{SERIES_KEY}/missing.jpg").status_code == 404

    # Path traversal must never leak backend source (falls through to SPA/404,
    # never serves a file outside the series folder).
    trav = client.get(f"/photos/{SERIES_KEY}/..%2f..%2fmain.py")
    assert b"FastAPI" not in trav.content and b"def health" not in trav.content


# ---------- state round-trip ----------


def test_curation_roundtrip_and_canonical_rule(client):
    rk = _record_key(0)

    # GET default (empty) state.
    r = client.get(f"/api/{SERIES_KEY}/curation")
    assert r.status_code == 200
    assert r.json()["photos"] == {}

    # Only accepted photos can be canonical.
    bad = client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "unreviewed", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )
    assert bad.status_code == 400

    # Accept + mark canonical.
    ok = client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": "clean"},
    )
    assert ok.status_code == 200
    assert ok.json()["photos"][rk]["isCanonical"] is True

    # GET reflects the write.
    again = client.get(f"/api/{SERIES_KEY}/curation").json()
    assert again["photos"][rk]["status"] == "accepted"

    # Status now shows one canonical (read from the aggregate /status).
    status = client.get(f"/api/{SERIES_KEY}/status").json()["curation"]
    assert status["totalCanonicals"] == 1
    assert status["readyCount"] == 1


def test_crop_roundtrip(client):
    rk = _record_key(0)
    # Make it canonical so crop status can count it.
    client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )

    box = {"x1": 10.0, "y1": 20.0, "x2": 300.0, "y2": 260.0, "source": "manual"}
    put = client.put(f"/api/{SERIES_KEY}/crop/{rk}", json=box)
    assert put.status_code == 200
    assert put.json()["crops"][rk]["x2"] == 300.0

    got = client.get(f"/api/{SERIES_KEY}/crop").json()
    assert got["crops"][rk]["source"] == "manual"

    status = client.get(f"/api/{SERIES_KEY}/status").json()["crop"]
    assert status["readyCount"] == 1
    assert status["locked"] is False

    locked = client.post(f"/api/{SERIES_KEY}/crop/lock").json()
    assert locked["lockedAt"] is not None
    assert client.get(f"/api/{SERIES_KEY}/status").json()["crop"]["locked"] is True


def test_crop_auto_one_unknown_record_404(client):
    """Per-record auto-suggest 404s on a bad recordKey before touching SAM."""
    r = client.post(f"/api/{SERIES_KEY}/crop/auto", params={"recordKey": f"{SERIES_KEY}/nope.jpg"})
    assert r.status_code == 404


@pytest.mark.needs_sam
def test_crop_auto_one_boxes_the_object(client):
    """Per-record auto returns a tight box around the ellipse, in the (angle-0)
    rotated-expanded frame (= raw dims here), and it round-trips through GET."""
    from app import processing

    if not processing.SAM_WEIGHTS_PATH.exists():
        pytest.skip("SAM weights not present")

    rk = _record_key(0)
    r = client.post(f"/api/{SERIES_KEY}/crop/auto", params={"recordKey": rk})
    assert r.status_code == 200
    box = r.json()["crops"][rk]
    assert box["source"] == "auto"
    # The ellipse lives at [120,90]-[300,220] in the 400x300 frame; the box (mask
    # bbox + 5% margin) should enclose it and stay inside the frame.
    assert 0 <= box["x1"] < 130 and box["x2"] > 290 and box["x2"] <= 400
    assert 0 <= box["y1"] < 100 and box["y2"] > 210 and box["y2"] <= 300

    got = client.get(f"/api/{SERIES_KEY}/crop").json()
    assert got["crops"][rk] == box


def test_taxonomy_roundtrip_preserves_data_keys(client):
    # Column names + assignment keys are data — must pass through untouched.
    payload = {
        "schemaVersion": 1,
        "updatedAt": "2026-07-06T00:00:00Z",
        "columns": [{"name": "Mass_kg", "type": "numeric"}],
        "assignments": {"100": {"Mass_kg": 80000.0}},
    }
    put = client.put(f"/api/{SERIES_KEY}/taxonomy", json=payload)
    assert put.status_code == 200
    got = client.get(f"/api/{SERIES_KEY}/taxonomy").json()
    assert got["columns"][0]["name"] == "Mass_kg"
    assert got["assignments"]["100"]["Mass_kg"] == 80000.0


# ---------- SAM gating ----------


def test_segment_gated_503_without_weights(client, monkeypatch):
    """With weights absent, segment returns a clean 503 (not a crash)."""
    from app import processing

    monkeypatch.setattr(processing, "SAM_WEIGHTS_PATH", tmp_missing := processing.SAM_WEIGHTS_PATH.parent / "nope.pth")
    assert not tmp_missing.exists()
    monkeypatch.setattr(deps, "_sam_predictor", None)

    r = client.post(f"/api/{SERIES_KEY}/mask/segment", json={"recordKey": _record_key(0)})
    assert r.status_code == 503
    assert "weights" in r.json()["detail"].lower()


@pytest.mark.needs_sam
def test_segment_returns_simplified_anchors(client):
    from app import processing

    if not processing.SAM_WEIGHTS_PATH.exists():
        pytest.skip("SAM weights not present")

    r = client.post(f"/api/{SERIES_KEY}/mask/segment", json={"recordKey": _record_key(0)})
    assert r.status_code == 200
    body = r.json()
    assert 3 <= len(body["anchorPath"]) <= models.ANCHOR_SIMPLIFY_TARGET
    assert body["outlinePointCount"] == models.DEFAULT_OUTLINE_POINTS
    assert all({"x", "y"} == set(p.keys()) for p in body["anchorPath"])


# ---------- standardized-image endpoint (Phase 6, no SAM) ----------


def test_standardized_image_serves_png(client):
    """The editor-background endpoint returns a PNG of the rotated+cropped frame.

    With no crop stored it falls back to the full (angle-0) frame — the raw 400x300
    ellipse image — so this needs no SAM and no crop set-up.
    """
    r = client.get(f"/api/{SERIES_KEY}/mask/{_record_key(0)}/image")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 0
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_standardized_image_honours_crop(client):
    """With a crop stored, the served PNG is the cropped size (no rotation at angle 0)."""
    from io import BytesIO

    from PIL import Image

    rk = _record_key(0)
    box = {"x1": 100.0, "y1": 80.0, "x2": 320.0, "y2": 240.0, "source": "manual"}
    assert client.put(f"/api/{SERIES_KEY}/crop/{rk}", json=box).status_code == 200

    r = client.get(f"/api/{SERIES_KEY}/mask/{rk}/image")
    assert r.status_code == 200
    img = Image.open(BytesIO(r.content))
    assert img.size == (220, 160)  # x2-x1, y2-y1


def test_standardized_image_unknown_record_404(client):
    assert client.get(f"/api/{SERIES_KEY}/mask/{SERIES_KEY}/nope.jpg/image").status_code == 404


def test_standardized_image_downscale_w(client):
    """``?w=`` downscales the served PNG to that width (aspect preserved) for the
    thumbnail grid; omitting it yields the full frame."""
    from io import BytesIO

    from PIL import Image

    rk = _record_key(0)
    full = Image.open(BytesIO(client.get(f"/api/{SERIES_KEY}/mask/{rk}/image").content))
    assert full.size == (400, 300)  # full ellipse frame, no crop

    small = Image.open(BytesIO(client.get(f"/api/{SERIES_KEY}/mask/{rk}/image?w=120").content))
    assert small.size == (120, 90)  # width 120, aspect preserved


def test_standardized_image_etag_304_and_recrop_invalidation(client):
    """A strong ETag lets an unchanged frame 304; a re-crop mints a NEW ETag and a
    fresh (differently-sized) PNG rather than the stale cached one."""
    from io import BytesIO

    from PIL import Image

    rk = _record_key(0)
    r1 = client.get(f"/api/{SERIES_KEY}/mask/{rk}/image?w=120")
    etag = r1.headers["ETag"]
    assert etag and r1.headers["Cache-Control"] == "no-cache"

    # Same frame + matching ETag → 304, empty body (browser reuses its copy).
    r304 = client.get(
        f"/api/{SERIES_KEY}/mask/{rk}/image?w=120", headers={"If-None-Match": etag}
    )
    assert r304.status_code == 304
    assert r304.content == b""

    # Re-crop (Stage 3) → the key/ETag change, so the same request now serves fresh
    # pixels from the new crop, and the old ETag no longer 304s.
    box = {"x1": 100.0, "y1": 80.0, "x2": 340.0, "y2": 200.0, "source": "manual"}
    assert client.put(f"/api/{SERIES_KEY}/crop/{rk}", json=box).status_code == 200

    r2 = client.get(
        f"/api/{SERIES_KEY}/mask/{rk}/image?w=120", headers={"If-None-Match": etag}
    )
    assert r2.status_code == 200
    assert r2.headers["ETag"] != etag
    # New crop is 240x120 → downscaled to width 120 = 60px tall (was 90 uncropped).
    assert Image.open(BytesIO(r2.content)).size == (120, 60)


# ---------- anchor-path resample → outline CSV (Phase 6, no SAM) ----------


def test_mask_put_writes_closed_even_outline(client):
    """PUT anchorPath → a resampled outline CSV that is closed (first≈last) and
    arc-length-even (Catmull-Rom, not a jagged polygon). Anchors persist as authority."""
    import numpy as np
    import pandas as pd

    from app.state import BACKEND_ROOT as STATE_BACKEND_ROOT

    rk = _record_key(0)
    client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )

    # An irregular quad — uneven spacing is exactly where uniform Catmull-Rom would
    # overshoot; centripetal must still give a clean evenly-spaced closed outline.
    anchors = [
        {"x": 20.0, "y": 20.0},
        {"x": 300.0, "y": 40.0},
        {"x": 260.0, "y": 220.0},
        {"x": 40.0, "y": 180.0},
    ]
    r = client.put(
        f"/api/{SERIES_KEY}/mask/{rk}",
        json={"recordKey": rk, "anchorPath": anchors, "seedPoints": [], "source": "manual"},
    )
    assert r.status_code == 200
    entry = r.json()["masks"][rk]
    assert entry["source"] == "manual"
    assert entry["anchorPath"] is not None and len(entry["anchorPath"]) == 4
    assert entry["outlinePointCount"] == models.DEFAULT_OUTLINE_POINTS

    csv_path = STATE_BACKEND_ROOT / entry["outlineRelPath"]
    assert csv_path.exists()
    pts = pd.read_csv(csv_path).values
    assert pts.shape == (models.DEFAULT_OUTLINE_POINTS, 2)

    # Closed + evenly spaced: segment lengths around the loop (including the wrap
    # from last point back to first) are near-uniform.
    closed = np.vstack([pts, pts[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    assert seg.std() / seg.mean() < 0.02  # arc-length resample → uniform spacing
    # The closing gap (last → first) is just one ordinary segment, not a jump.
    assert np.linalg.norm(pts[-1] - pts[0]) < 2.0 * seg.mean()


def test_mask_put_rejects_degenerate_path(client):
    rk = _record_key(0)
    r = client.put(
        f"/api/{SERIES_KEY}/mask/{rk}",
        json={
            "recordKey": rk,
            "anchorPath": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 1.0}],
            "seedPoints": [],
            "source": "manual",
        },
    )
    assert r.status_code == 400


# ---------- Stage 5 export (Phase 7, no SAM) ----------


def _make_ready(client, rk: str) -> None:
    """Drive one record through curation → orient → crop → mask so export exports it.

    None of this needs SAM: mask PUT resamples the given anchors into the outline CSV.
    """
    client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )
    client.put(
        f"/api/{SERIES_KEY}/orient/{rk}",
        json={"angleDeg": 0.0, "source": "manual", "isPrimingExample": True},
    )
    client.put(
        f"/api/{SERIES_KEY}/crop/{rk}",
        json={"x1": 20.0, "y1": 20.0, "x2": 320.0, "y2": 240.0, "source": "manual"},
    )
    client.put(
        f"/api/{SERIES_KEY}/mask/{rk}",
        json={
            "recordKey": rk,
            "anchorPath": [
                {"x": 40.0, "y": 40.0},
                {"x": 280.0, "y": 60.0},
                {"x": 240.0, "y": 200.0},
                {"x": 60.0, "y": 180.0},
            ],
            "seedPoints": [],
            "source": "manual",
        },
    )


def test_export_writes_bundle_and_skips_not_ready(client):
    """Export writes out/{images,outlines,manifest.csv}; a fully-driven specimen lands
    in the manifest (with every specified column), and a not-ready one is skipped."""
    import pandas as pd

    from app.state import BACKEND_ROOT as STATE_BACKEND_ROOT

    ready_rk = _record_key(0)
    _make_ready(client, ready_rk)

    # A second canonical with NO mask/crop/orient — must be skipped, not dropped.
    not_ready_rk = _record_key(1)
    client.put(
        f"/api/{SERIES_KEY}/curation/{not_ready_rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )

    r = client.post(f"/api/{SERIES_KEY}/export")
    assert r.status_code == 200
    body = r.json()

    assert body["exportedCount"] == 1
    skipped_keys = {s["recordKey"] for s in body["skipped"]}
    assert skipped_keys == {not_ready_rk}
    reason = next(s["reason"] for s in body["skipped"] if s["recordKey"] == not_ready_rk)
    assert "orient" in reason and "crop" in reason and "mask" in reason

    out_dir = (STATE_BACKEND_ROOT / body["manifestPath"]).parent

    # The exported image + outline exist under out/.
    images = sorted((out_dir / "images").glob("*.png"))
    outlines = sorted((out_dir / "outlines").glob("*.csv"))
    assert len(images) == 1 and len(outlines) == 1
    assert images[0].read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    # Manifest carries exactly one row with every specified column.
    manifest = pd.read_csv(STATE_BACKEND_ROOT / body["manifestPath"])
    assert len(manifest) == 1
    for col in [
        "specimenId",
        "label",
        "series",
        "filename",
        "outlinePath",
        "pointCount",
        "orientSource",
        "cropSource",
        "maskSource",
    ]:
        assert col in manifest.columns, f"manifest missing column {col!r}"
    row = manifest.iloc[0]
    assert row["series"] == SERIES_KEY
    assert row["pointCount"] == models.DEFAULT_OUTLINE_POINTS
    assert row["orientSource"] == "manual"
    assert row["cropSource"] == "manual"
    assert row["maskSource"] == "manual"
    # The outlinePath in the manifest resolves and has DEFAULT_OUTLINE_POINTS rows.
    outline_csv = STATE_BACKEND_ROOT / row["outlinePath"]
    assert outline_csv.exists()
    assert len(pd.read_csv(outline_csv)) == models.DEFAULT_OUTLINE_POINTS


# ---------- Stage 6 EFA + Stage 7 PCA (Phase 8, no SAM) ----------

# Distinct outlines per specimen so PCA is non-degenerate (identical shapes give a
# zero-variance covariance and a NaN variance ratio). A wide box vs a tall box.
_SHAPES = {
    0: [{"x": 30.0, "y": 90.0}, {"x": 300.0, "y": 80.0},
        {"x": 300.0, "y": 160.0}, {"x": 30.0, "y": 170.0}],
    1: [{"x": 130.0, "y": 20.0}, {"x": 220.0, "y": 20.0},
        {"x": 230.0, "y": 260.0}, {"x": 120.0, "y": 260.0}],
}


def _make_ready_shape(client, i: int) -> None:
    """Drive record ``i`` through the pipeline with its own distinct outline shape."""
    _make_ready(client, _record_key(i))
    rk = _record_key(i)
    client.put(
        f"/api/{SERIES_KEY}/mask/{rk}",
        json={"recordKey": rk, "anchorPath": _SHAPES[i], "seedPoints": [], "source": "manual"},
    )


def test_efa_calibrate_monotonic_and_recommends(client):
    """Calibrate pools cumulative-power curves across the masked canonicals and
    returns a monotonically non-decreasing mean curve plus harmonic recommendations."""
    for i in (0, 1):
        _make_ready_shape(client, i)

    r = client.post(f"/api/{SERIES_KEY}/efa/calibrate")
    assert r.status_code == 200
    body = r.json()
    assert body["nSpecimens"] == 2
    curve = body["meanCurve"]
    assert len(curve) == models.MAX_HARMONICS
    # Cumulative power fraction is monotonic non-decreasing and lands in [0, 1].
    assert all(b >= a - 1e-9 for a, b in zip(curve, curve[1:]))
    assert 0.0 <= curve[0] and curve[-1] <= 1.0 + 1e-9
    thresholds = {rec["threshold"] for rec in body["recommended"]}
    assert thresholds == {0.95, 0.99, 0.999}
    # Each recommendation is a valid harmonic count.
    assert all(1 <= rec["harmonics"] <= models.MAX_HARMONICS for rec in body["recommended"])


def test_efa_compute_writes_coefficients_and_settings(client):
    """Compute writes efa/coefficients.csv (one row per canonical, 4·H coef columns)
    and persists harmonics/normalize/lastComputedAt in efa_settings."""
    import pandas as pd

    from app import state

    for i in (0, 1):
        _make_ready_shape(client, i)

    r = client.post(f"/api/{SERIES_KEY}/efa/compute", json={"harmonics": 10, "normalize": True})
    assert r.status_code == 200
    settings = r.json()
    assert settings["harmonics"] == 10
    assert settings["normalize"] is True
    assert settings["nSpecimensComputed"] == 2
    assert settings["lastComputedAt"] is not None

    coeff_csv = state.STATE_ROOT / SERIES_KEY / "efa" / "coefficients.csv"
    assert coeff_csv.exists()
    df = pd.read_csv(coeff_csv)
    assert len(df) == 2
    # specimen_id_safe + a1..d10 = 1 + 40 columns.
    assert "specimen_id_safe" in df.columns
    assert len([c for c in df.columns if c != "specimen_id_safe"]) == 40

    # GET reflects the persisted settings.
    got = client.get(f"/api/{SERIES_KEY}/efa").json()
    assert got["harmonics"] == 10 and got["lastComputedAt"] is not None


def test_efa_reconstruct_returns_outline_and_power(client):
    """The inspector reconstruct returns a closed outline + a per-harmonic power
    spectrum of the requested length; the LRU serves a repeat call identically."""
    _make_ready(client, _record_key(0))

    req = {"recordKey": _record_key(0), "harmonics": 8, "normalize": True}
    r = client.post(f"/api/{SERIES_KEY}/efa/reconstruct", json=req)
    assert r.status_code == 200
    body = r.json()
    assert len(body["outline"]) == models.DEFAULT_OUTLINE_POINTS // 2
    assert all({"x", "y"} == set(p.keys()) for p in body["outline"])
    assert len(body["powerSpectrum"]) == 8

    # Cache hit — identical result for identical (record, harmonics, normalize).
    again = client.post(f"/api/{SERIES_KEY}/efa/reconstruct", json=req).json()
    assert again == body


def test_efa_reconstruct_unmasked_409(client):
    """Reconstruct on a canonical with no outline is a clean 409, not a crash."""
    rk = _record_key(0)
    client.put(
        f"/api/{SERIES_KEY}/curation/{rk}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )
    r = client.post(
        f"/api/{SERIES_KEY}/efa/reconstruct",
        json={"recordKey": rk, "harmonics": 8, "normalize": True},
    )
    assert r.status_code == 409


def test_pca_run_writes_three_csvs_and_settings(client):
    """Run PCA writes scores/loadings/eigenvalues CSVs, records harmonicsUsed, and
    auto-picks the retained-component count from the variance target."""
    import pandas as pd

    from app import state

    for i in (0, 1):
        _make_ready_shape(client, i)
    client.post(f"/api/{SERIES_KEY}/efa/compute", json={"harmonics": 8, "normalize": True})

    r = client.post(f"/api/{SERIES_KEY}/pca/run", json={})
    assert r.status_code == 200
    result = r.json()
    assert result["specimenIds"] and len(result["scores"]) == 2
    # Cumulative variance is monotonic and its last entry ≈ 1.0.
    cum = result["cumVarRatio"]
    assert all(b >= a - 1e-9 for a, b in zip(cum, cum[1:]))
    assert abs(cum[-1] - 1.0) < 1e-6

    pca_dir = state.STATE_ROOT / SERIES_KEY / "pca"
    for name in ("scores.csv", "loadings.csv", "eigenvalues.csv"):
        assert (pca_dir / name).exists(), f"missing {name}"
    loadings = pd.read_csv(pca_dir / "loadings.csv")
    assert "feature" in loadings.columns and "mean" in loadings.columns

    # Settings carry the harmonics used (drift-banner input) and a retained count.
    settings = client.get(f"/api/{SERIES_KEY}/pca/settings").json()
    assert settings["harmonicsUsed"] == 8
    assert settings["lastComputedAt"] is not None
    assert settings["nComponentsRetained"] is not None


def _seed_coefficients(ids: list[str], harmonics: int = 8) -> None:
    """Write a synthetic efa/coefficients.csv (+ efa_settings) for the test series.

    Group ``B*`` is a massive outlier on the first coefficient, so it dominates the
    variance — the exact scenario the exclude-from-fit feature exists for.
    """
    import json

    import numpy as np
    import pandas as pd

    from app import analysis, state

    cols = analysis.coefficient_column_names(harmonics)
    rng = np.random.RandomState(0)
    X = rng.normal(0.0, 0.1, size=(len(ids), len(cols)))
    for i, sid in enumerate(ids):
        if sid.startswith("B"):
            X[i, 0] += 50.0  # outlier group drives PC1
    df = pd.DataFrame(X, columns=cols)
    df.insert(0, "specimen_id_safe", ids)
    series_dir = state.STATE_ROOT / SERIES_KEY
    (series_dir / "efa").mkdir(parents=True, exist_ok=True)
    df.to_csv(series_dir / "efa" / "coefficients.csv", index=False)
    (series_dir / "efa_settings.json").write_text(json.dumps({"harmonics": harmonics}))


def test_pca_excludes_specimens_and_refits(client):
    """Excluding a group drops it from the fit and recomputes the axes on the rest;
    the exclusion persists, clears on [], and refuses to leave too few specimens."""
    ids = ["A1", "A2", "A3", "B1", "B2"]
    _seed_coefficients(ids)

    full = client.post(f"/api/{SERIES_KEY}/pca/run", json={}).json()
    assert len(full["specimenIds"]) == 5
    assert full["varRatio"][0] > 0.9  # the B outlier group dominates PC1

    # Exclude the dominant group → refit on the remaining three.
    sub = client.post(
        f"/api/{SERIES_KEY}/pca/run", json={"excludedSpecimens": ["B1", "B2"]}
    ).json()
    assert sorted(sub["specimenIds"]) == ["A1", "A2", "A3"]
    assert "B1" not in sub["specimenIds"] and "B2" not in sub["specimenIds"]
    # Variance is redistributed now the outlier is gone (PC1 no longer ~all of it).
    assert sub["varRatio"][0] < full["varRatio"][0]

    # Exclusion persists: GET /pca and settings both reflect the subset.
    got = client.get(f"/api/{SERIES_KEY}/pca").json()
    assert sorted(got["specimenIds"]) == ["A1", "A2", "A3"]
    settings = client.get(f"/api/{SERIES_KEY}/pca/settings").json()
    assert sorted(settings["excludedSpecimens"]) == ["B1", "B2"]

    # Too few remaining → 409, and the bad exclusion is not persisted.
    over = client.post(
        f"/api/{SERIES_KEY}/pca/run", json={"excludedSpecimens": ["A1", "A2", "A3", "B1"]}
    )
    assert over.status_code == 409
    assert sorted(
        client.get(f"/api/{SERIES_KEY}/pca/settings").json()["excludedSpecimens"]
    ) == ["B1", "B2"]

    # Reset: [] refits on everyone.
    cleared = client.post(f"/api/{SERIES_KEY}/pca/run", json={"excludedSpecimens": []}).json()
    assert len(cleared["specimenIds"]) == 5
    assert client.get(f"/api/{SERIES_KEY}/pca/settings").json()["excludedSpecimens"] == []


def test_pca_before_efa_409(client):
    """Running PCA before any EFA compute is a clean 409."""
    _make_ready(client, _record_key(0))
    r = client.post(f"/api/{SERIES_KEY}/pca/run", json={})
    assert r.status_code == 409


def test_pca_reconstruct_returns_closed_outline(client):
    """Back-projecting a point in PC space (Stage-8 shape-along-PC strips) returns a
    closed outline of {x, y} points; moving along a PC changes the shape."""
    for i in (0, 1):
        _make_ready_shape(client, i)
    client.post(f"/api/{SERIES_KEY}/efa/compute", json={"harmonics": 8, "normalize": True})
    client.post(f"/api/{SERIES_KEY}/pca/run", json={})

    mean = client.post(f"/api/{SERIES_KEY}/pca/reconstruct", json={"pcValues": {}})
    assert mean.status_code == 200
    mean_outline = mean.json()["outline"]
    assert len(mean_outline) >= 3
    assert all({"x", "y"} == set(p.keys()) for p in mean_outline)
    # Closed: first and last vertices coincide.
    assert abs(mean_outline[0]["x"] - mean_outline[-1]["x"]) < 1e-6
    assert abs(mean_outline[0]["y"] - mean_outline[-1]["y"]) < 1e-6

    # Moving +1.5 along PC1 yields a different shape than the mean.
    shifted = client.post(
        f"/api/{SERIES_KEY}/pca/reconstruct", json={"pcValues": {"1": 1.5}}
    ).json()["outline"]
    assert len(shifted) == len(mean_outline)
    assert any(
        abs(a["x"] - b["x"]) > 1e-6 or abs(a["y"] - b["y"]) > 1e-6
        for a, b in zip(mean_outline, shifted)
    )


# ---------- Phase 11B: exemplars + automate ----------
#
# A brown-blob photo set (bone_colour_mask isolates a saturated brown blob on a
# neutral frame) + a fake SamPredictor, so the batch endpoint's state-writing and
# flagging logic is exercised deterministically without the SAM weights.

BROWN_SERIES_DISPLAY = "Brownus (View A)"
BROWN_SERIES_KEY = "brownus_view_a"
BROWN_PHOTOS = ["Brownus_species_200_1.jpg", "Brownus_species_201_1.jpg", "Brownus_species_202_1.jpg"]
_BLOB_CENTER = (250, 250)
_BLOB_RADII = (95, 58)


def _brown_blob_array():
    """500x500 neutral-gray frame with one saturated-brown, non-convex blob."""
    import cv2
    import numpy as np

    img = np.full((500, 500, 3), 210, dtype=np.uint8)
    cv2.ellipse(img, _BLOB_CENTER, _BLOB_RADII, 0, 0, 360, (150, 90, 40), -1)
    cv2.ellipse(img, (205, 250), (26, 70), 0, 0, 360, (210, 210, 210), -1)  # bite → low solidity
    return img


def _blob_mask():
    """Full-frame bool mask matching the blob location (what the fake SAM returns)."""
    import cv2
    import numpy as np

    m = np.zeros((500, 500), np.uint8)
    cv2.ellipse(m, _BLOB_CENTER, _BLOB_RADII, 0, 0, 360, 1, -1)
    cv2.ellipse(m, (205, 250), (26, 70), 0, 0, 360, 0, -1)
    return m.astype(bool)


class _FakeSam:
    """SamPredictor stand-in returning a preset (mask, score) for any box."""

    def __init__(self, mask, score=0.98):
        self._mask, self._score = mask, score

    def set_image(self, image_rgb):
        pass

    def predict(self, box=None, point_coords=None, point_labels=None, multimask_output=False):
        import numpy as np

        return self._mask[None, ...], np.array([self._score], np.float32), None


@pytest.fixture()
def brown_env(tmp_path, monkeypatch):
    from PIL import Image

    from app import state

    monkeypatch.setattr(state, "STATE_ROOT", tmp_path / "state")
    photos_root = tmp_path / "photos"
    sdir = photos_root / BROWN_SERIES_DISPLAY
    sdir.mkdir(parents=True)
    blob = _brown_blob_array()
    import numpy as np

    Image.fromarray(blob).save(sdir / BROWN_PHOTOS[0])  # exemplar source
    Image.fromarray(blob).save(sdir / BROWN_PHOTOS[1])  # auto target → isolates + matches
    Image.fromarray(np.full((500, 500, 3), 210, np.uint8)).save(sdir / BROWN_PHOTOS[2])  # neutral → detection_failed
    monkeypatch.setenv("MORPH_FOURIER_PHOTOS_ROOT", str(photos_root))
    monkeypatch.setattr(deps, "_sam_predictor", None)
    return tmp_path


@pytest.fixture()
def brown_client(brown_env):
    return TestClient(app)


def _mark_canonical(client, series_key, record_key):
    r = client.put(
        f"/api/{series_key}/curation/{record_key}",
        json={"status": "accepted", "rejectionReason": None, "isCanonical": True, "notes": ""},
    )
    assert r.status_code == 200


def _exemplar_payload_from_photo0():
    """Build a real exemplar from photo0 via the fake SAM (mirrors what Prime writes)."""
    from app import autodetect as ad
    from app.api import automate as automate_mod

    img = _brown_blob_array()
    det = ad.detect_target_box(img)
    assert det.box is not None and not det.flagged
    seg = ad.segment_in_box(img, det.box, _FakeSam(_blob_mask()))
    assert not seg.flagged and seg.outline is not None
    ex = ad.build_exemplar(f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}", seg.outline, det.box, 0.0)
    return automate_mod.exemplar_to_model(ex).model_dump(by_alias=True)


def test_exemplars_roundtrip_persists_oriented_outline(brown_client):
    """PUT→GET the exemplar set; the oriented OUTLINE round-trips (11B correction)."""
    payload = _exemplar_payload_from_photo0()
    body = {"schemaVersion": 1, "harmonics": 8, "exemplars": [payload]}

    put = brown_client.put(f"/api/{BROWN_SERIES_KEY}/exemplars", json=body)
    assert put.status_code == 200

    got = brown_client.get(f"/api/{BROWN_SERIES_KEY}/exemplars").json()
    assert got["harmonics"] == 8 and len(got["exemplars"]) == 1
    ex = got["exemplars"][0]
    assert ex["recordKey"] == f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    # The dense oriented outline is persisted (not just efaCoeffs) — the correction.
    assert len(ex["outline"]) > 100
    assert all({"x", "y"} == set(p.keys()) for p in ex["outline"][:3])
    # efaCoeffs is the nested (harmonics × 4) block.
    assert len(ex["efaCoeffs"]) == 8 and all(len(row) == 4 for row in ex["efaCoeffs"])
    assert {"x1", "y1", "x2", "y2", "source"} <= set(ex["cropBox"].keys())


def test_automate_no_exemplars_short_circuits(brown_client):
    """With canonicals but no exemplar set, automate flags nothing and reports it."""
    for p in BROWN_PHOTOS:
        _mark_canonical(brown_client, BROWN_SERIES_KEY, f"{BROWN_SERIES_KEY}/{p}")
    r = brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate")
    assert r.status_code == 200
    body = r.json()
    assert body["skippedNoExemplars"] is True
    assert body["processed"] == 0 and body["autoIsolated"] == 0


def test_automate_writes_state_and_flags(brown_client, monkeypatch):
    """End-to-end automate (fake SAM): isolates + matches the brown target, flags the
    neutral photo as detection_failed, and writes crop/orient/mask + AutoResults."""
    from app.api import automate as automate_mod

    # Prime photo0 as the exemplar; make all three canonical.
    brown_client.put(
        f"/api/{BROWN_SERIES_KEY}/exemplars",
        json={"schemaVersion": 1, "harmonics": 8, "exemplars": [_exemplar_payload_from_photo0()]},
    )
    for p in BROWN_PHOTOS:
        _mark_canonical(brown_client, BROWN_SERIES_KEY, f"{BROWN_SERIES_KEY}/{p}")

    # Force the fake predictor regardless of real weights.
    monkeypatch.setattr(automate_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask()))

    r = brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate")
    assert r.status_code == 200
    s = r.json()
    assert s["skippedNoExemplars"] is False
    assert s["processed"] == 2  # photo1 + photo2 (photo0 is primed, excluded)
    assert s["autoIsolated"] == 1 and s["matched"] == 1
    assert s["flaggedDetectionFailed"] == 1 and s["flagged"] == 1
    assert s["elapsedSeconds"] >= 0.0

    target = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[1]}"
    neutral = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[2]}"

    crop = brown_client.get(f"/api/{BROWN_SERIES_KEY}/crop").json()["crops"]
    assert crop[target]["source"] == "auto" and neutral not in crop

    orient = brown_client.get(f"/api/{BROWN_SERIES_KEY}/orient").json()["orientations"]
    assert orient[target]["source"] == "learned"
    assert 0.0 <= orient[target]["angleDeg"] < 360.0

    mask = brown_client.get(f"/api/{BROWN_SERIES_KEY}/mask").json()["masks"]
    assert mask[target]["source"] == "auto"
    from app.state import BACKEND_ROOT

    assert (BACKEND_ROOT / mask[target]["outlineRelPath"]).exists()

    results = brown_client.get(f"/api/{BROWN_SERIES_KEY}/auto-results").json()["results"]
    assert results[target]["source"] == "auto" and results[target]["flagged"] is False
    assert results[target]["matchedExemplarKey"] == f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    assert results[target]["matchDistance"] is not None
    assert results[neutral]["flagged"] is True
    assert results[neutral]["flagReason"] == "detection_failed"
    assert results[neutral]["flagDetail"] in (
        "no_bone_colour", "warm_background", "no_target", "fill_reject",
        "low_sam_score", "scale_card", "segmentation_failed"
    )


# ---------- Phase 11C: Prime (guided crop → SAM → mask → orient → save) ----------
#
# Reuses the brown-blob fixture + fake SAM so the crop-before-orient flow's three
# round-trips (segment / cropped image / exemplar save) are deterministic.


def _fake_prime_sam(monkeypatch):
    """Force the Prime segment endpoint onto the deterministic fake SAM."""
    from app.api import prime as prime_mod

    monkeypatch.setattr(prime_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask()))


def _blob_box() -> dict:
    """A loose raw-frame box around the brown blob (its bbox + slack)."""
    cx, cy = _BLOB_CENTER
    rx, ry = _BLOB_RADII
    return {"x1": cx - rx - 15, "y1": cy - ry - 15, "x2": cx + rx + 15, "y2": cy + ry + 15, "source": "manual"}


def test_prime_segment_returns_box_frame_anchors(brown_client, monkeypatch):
    """SAM box-predict inside the raw-frame box → simplified anchors in the box frame."""
    _fake_prime_sam(monkeypatch)
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    r = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": rk, "box": _blob_box()}
    )
    assert r.status_code == 200
    body = r.json()
    assert 3 <= len(body["anchorPath"]) <= models.ANCHOR_SIMPLIFY_TARGET
    assert body["outlinePointCount"] == models.DEFAULT_OUTLINE_POINTS
    # Anchors are box-relative: within the box's own [0, w]×[0, h] extent.
    box = _blob_box()
    bw, bh = box["x2"] - box["x1"], box["y2"] - box["y1"]
    assert all(0 <= p["x"] <= bw and 0 <= p["y"] <= bh for p in body["anchorPath"])


def test_prime_segment_gated_503_without_weights(brown_client, monkeypatch):
    from app import processing

    monkeypatch.setattr(processing, "SAM_WEIGHTS_PATH", processing.SAM_WEIGHTS_PATH.parent / "nope.pth")
    monkeypatch.setattr(deps, "_sam_predictor", None)
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    r = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": rk, "box": _blob_box()}
    )
    assert r.status_code == 503


def test_prime_image_serves_cropped_png(brown_client):
    """The editor-background endpoint returns a PNG of just the raw-frame crop region."""
    from io import BytesIO

    from PIL import Image

    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    box = _blob_box()
    r = brown_client.get(
        f"/api/{BROWN_SERIES_KEY}/prime/{rk}/image",
        params={"x1": box["x1"], "y1": box["y1"], "x2": box["x2"], "y2": box["y2"]},
    )
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    img = Image.open(BytesIO(r.content))
    assert img.size == (box["x2"] - box["x1"], box["y2"] - box["y1"])
    # A downscale request is honoured (thumbnail path).
    small = brown_client.get(
        f"/api/{BROWN_SERIES_KEY}/prime/{rk}/image",
        params={"x1": box["x1"], "y1": box["y1"], "x2": box["x2"], "y2": box["y2"], "w": 80},
    )
    assert Image.open(BytesIO(small.content)).width == 80


def test_prime_exemplar_save_derives_efa_and_recovers_display_angle(brown_client, monkeypatch):
    """PUT /prime/exemplar with box-frame anchors + a display angle. The backend derives
    the oriented outline + normalized efaCoeffs; the persisted outline recovers back to
    the display angle the user set (Prime ↔ Automate sign parity)."""
    import numpy as np

    from app import autodetect as ad
    from app import processing

    _fake_prime_sam(monkeypatch)
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    box = _blob_box()

    seg = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": rk, "box": box}
    ).json()
    anchor_path = seg["anchorPath"]

    display = 40.0
    put = brown_client.put(
        f"/api/{BROWN_SERIES_KEY}/prime/exemplar",
        json={"recordKey": rk, "cropBox": box, "angleDeg": display, "anchorPath": anchor_path},
    )
    assert put.status_code == 200
    st = put.json()
    assert len(st["exemplars"]) == 1
    ex = st["exemplars"][0]
    assert ex["recordKey"] == rk and ex["angleDeg"] == display
    # Backend-derived: dense oriented outline + nested (harmonics × 4) efaCoeffs.
    assert len(ex["outline"]) == models.DEFAULT_OUTLINE_POINTS
    assert len(ex["efaCoeffs"]) == 8 and all(len(row) == 4 for row in ex["efaCoeffs"])
    assert ex["cropBox"]["x1"] == box["x1"] and ex["cropBox"]["source"] == "manual"

    # Sign parity: recovering the persisted (oriented) outline from the box outline
    # returns the display angle the user set — exactly what Automate will do.
    anchor_xy = np.array([[p["x"], p["y"]] for p in anchor_path], dtype=np.float64)
    dense_box = processing.resample_anchor_path(anchor_xy, models.DEFAULT_OUTLINE_POINTS)
    oriented = np.array([[p["x"], p["y"]] for p in ex["outline"]], dtype=np.float64)
    recovered, _ = ad.recover_angle(dense_box, oriented)
    err = (ad.to_display_angle(recovered) - display + 180) % 360 - 180
    assert abs(err) < 0.5

    # Persisted to exemplars.json (GET reads it back).
    got = brown_client.get(f"/api/{BROWN_SERIES_KEY}/exemplars").json()
    assert len(got["exemplars"]) == 1 and got["exemplars"][0]["recordKey"] == rk


def test_prime_exemplar_upsert_and_delete(brown_client, monkeypatch):
    """Re-priming replaces (not duplicates) by recordKey; DELETE un-primes."""
    _fake_prime_sam(monkeypatch)
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    box = _blob_box()
    anchor_path = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": rk, "box": box}
    ).json()["anchorPath"]

    def _put(angle):
        return brown_client.put(
            f"/api/{BROWN_SERIES_KEY}/prime/exemplar",
            json={"recordKey": rk, "cropBox": box, "angleDeg": angle, "anchorPath": anchor_path},
        )

    assert len(_put(0.0).json()["exemplars"]) == 1
    st = _put(90.0).json()  # same record → replace
    assert len(st["exemplars"]) == 1 and st["exemplars"][0]["angleDeg"] == 90.0

    d = brown_client.delete(f"/api/{BROWN_SERIES_KEY}/prime/exemplar/{rk}")
    assert d.status_code == 200 and d.json()["exemplars"] == []


# ---------- Phase 11D: primed carry-forward + Review refine ----------
#
# Automate must materialise the hand-primed exemplars into crop/orient/mask (they
# live only in exemplars.json otherwise, so Gallery/EFA/PCA would drop them), and
# Review's box-frame refine overwrites a specimen's geometry (not the exemplar set).


def test_automate_materializes_primed_into_geometry(brown_client, monkeypatch):
    """Primed exemplars are carried into crop/orient/mask (+ outline CSV) and an
    auto-result with source='primed', so the hand-curated specimens are first-class
    members of the analysed set — not just the auto-isolated ones."""
    from app.api import automate as automate_mod
    from app.state import BACKEND_ROOT

    brown_client.put(
        f"/api/{BROWN_SERIES_KEY}/exemplars",
        json={"schemaVersion": 1, "harmonics": 8, "exemplars": [_exemplar_payload_from_photo0()]},
    )
    for p in BROWN_PHOTOS:
        _mark_canonical(brown_client, BROWN_SERIES_KEY, f"{BROWN_SERIES_KEY}/{p}")
    monkeypatch.setattr(automate_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask()))

    s = brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate").json()
    assert s["primed"] == 1  # photo0 carried forward
    assert s["processed"] == 2  # photo1 + photo2 (primed excluded from the batch)

    primed_rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"

    crop = brown_client.get(f"/api/{BROWN_SERIES_KEY}/crop").json()["crops"]
    assert primed_rk in crop

    orient = brown_client.get(f"/api/{BROWN_SERIES_KEY}/orient").json()["orientations"]
    assert orient[primed_rk]["isPrimingExample"] is True

    mask = brown_client.get(f"/api/{BROWN_SERIES_KEY}/mask").json()["masks"]
    assert mask[primed_rk]["source"] == "manual"
    assert (BACKEND_ROOT / mask[primed_rk]["outlineRelPath"]).exists()

    results = brown_client.get(f"/api/{BROWN_SERIES_KEY}/auto-results").json()["results"]
    assert results[primed_rk]["source"] == "primed"
    assert results[primed_rk]["flagged"] is False


def test_automate_clears_stale_geometry_when_a_target_fails(brown_client, monkeypatch):
    """Re-running Automate must not leave a prior run's outline on a specimen that fails
    this run — state files are cumulative, and Gallery/EFA/PCA read mask.json, so a stale
    rectangle would silently pollute the analysis. A flagged specimen ends with no mask."""
    from app.api import automate as automate_mod

    brown_client.put(
        f"/api/{BROWN_SERIES_KEY}/exemplars",
        json={"schemaVersion": 1, "harmonics": 8, "exemplars": [_exemplar_payload_from_photo0()]},
    )
    for p in BROWN_PHOTOS:
        _mark_canonical(brown_client, BROWN_SERIES_KEY, f"{BROWN_SERIES_KEY}/{p}")

    target = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[1]}"

    # Run 1 — a clean SAM mask: the target gets an outline written.
    monkeypatch.setattr(automate_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask(), 0.98))
    brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate")
    assert target in brown_client.get(f"/api/{BROWN_SERIES_KEY}/mask").json()["masks"]

    # Run 2 — SAM now scores below the reject floor: the target flags and its stale
    # outline is cleared, not carried forward.
    monkeypatch.setattr(automate_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask(), 0.40))
    brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate")
    assert target not in brown_client.get(f"/api/{BROWN_SERIES_KEY}/mask").json()["masks"]
    assert target not in brown_client.get(f"/api/{BROWN_SERIES_KEY}/crop").json()["crops"]
    results = brown_client.get(f"/api/{BROWN_SERIES_KEY}/auto-results").json()["results"]
    assert results[target]["flagged"] is True


def test_review_refine_overwrites_geometry_and_marks_manual(brown_client, monkeypatch):
    """Review's box-frame refine writes crop/orient/mask (Gallery/EFA authority) and
    stamps a human source='manual', unflagged AutoResult — leaving exemplars.json alone."""
    from app.state import BACKEND_ROOT

    _fake_prime_sam(monkeypatch)
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[1]}"
    _mark_canonical(brown_client, BROWN_SERIES_KEY, rk)
    box = _blob_box()
    anchor_path = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": rk, "box": box}
    ).json()["anchorPath"]

    r = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/review/refine",
        json={"recordKey": rk, "cropBox": box, "angleDeg": 25.0, "anchorPath": anchor_path},
    )
    assert r.status_code == 200
    res = r.json()
    assert res["source"] == "manual" and res["flagged"] is False

    crop = brown_client.get(f"/api/{BROWN_SERIES_KEY}/crop").json()["crops"]
    assert crop[rk]["source"] == "manual" and crop[rk]["x1"] == box["x1"]

    orient = brown_client.get(f"/api/{BROWN_SERIES_KEY}/orient").json()["orientations"]
    assert orient[rk]["angleDeg"] == 25.0 and orient[rk]["source"] == "manual"

    mask = brown_client.get(f"/api/{BROWN_SERIES_KEY}/mask").json()["masks"]
    assert mask[rk]["source"] == "manual"
    assert mask[rk]["outlinePointCount"] == models.DEFAULT_OUTLINE_POINTS
    assert (BACKEND_ROOT / mask[rk]["outlineRelPath"]).exists()

    # Refine ≠ prime: the exemplar set is untouched.
    assert brown_client.get(f"/api/{BROWN_SERIES_KEY}/exemplars").json()["exemplars"] == []

    results = brown_client.get(f"/api/{BROWN_SERIES_KEY}/auto-results").json()["results"]
    assert results[rk]["source"] == "manual" and results[rk]["flagged"] is False


def test_automate_preserves_known_good_refined(brown_client, monkeypatch):
    """A specimen the user hand-refined in Review (source='manual') is treated as
    'known good' on a re-run: excluded from the batch (never overwritten) and reused
    as an exemplar. Carlos's rule — anything done manually counts as primed next run."""
    from app.api import automate as automate_mod

    # Prime photo0, make all three canonical, and hand-refine photo1 in Review.
    brown_client.put(
        f"/api/{BROWN_SERIES_KEY}/exemplars",
        json={"schemaVersion": 1, "harmonics": 8, "exemplars": [_exemplar_payload_from_photo0()]},
    )
    for p in BROWN_PHOTOS:
        _mark_canonical(brown_client, BROWN_SERIES_KEY, f"{BROWN_SERIES_KEY}/{p}")

    _fake_prime_sam(monkeypatch)
    refined_rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[1]}"
    box = _blob_box()
    anchor_path = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/prime/segment", json={"recordKey": refined_rk, "box": box}
    ).json()["anchorPath"]
    brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/review/refine",
        json={"recordKey": refined_rk, "cropBox": box, "angleDeg": 25.0, "anchorPath": anchor_path},
    )

    monkeypatch.setattr(automate_mod.deps, "get_sam_predictor", lambda: _FakeSam(_blob_mask()))
    s = brown_client.post(f"/api/{BROWN_SERIES_KEY}/automate").json()

    # photo0 primed + photo1 refined are both excluded; only photo2 is processed.
    assert s["primed"] == 1
    assert s["knownGoodPreserved"] == 1
    assert s["processed"] == 1

    # The refine is untouched: its human angle + manual provenance survive the run.
    orient = brown_client.get(f"/api/{BROWN_SERIES_KEY}/orient").json()["orientations"]
    assert orient[refined_rk]["angleDeg"] == 25.0 and orient[refined_rk]["source"] == "manual"
    results = brown_client.get(f"/api/{BROWN_SERIES_KEY}/auto-results").json()["results"]
    assert results[refined_rk]["source"] == "manual"


def test_review_refine_rejects_degenerate_path(brown_client):
    """A <3-point anchor path can't form an outline → 400 (no state written)."""
    rk = f"{BROWN_SERIES_KEY}/{BROWN_PHOTOS[0]}"
    r = brown_client.post(
        f"/api/{BROWN_SERIES_KEY}/review/refine",
        json={
            "recordKey": rk,
            "cropBox": _blob_box(),
            "angleDeg": 0.0,
            "anchorPath": [{"x": 1, "y": 1}, {"x": 2, "y": 2}],
        },
    )
    assert r.status_code == 400
