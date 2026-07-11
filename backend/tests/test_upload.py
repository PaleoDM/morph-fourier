"""Upload flow: create a series and add images through the API (no manual file ops).

Runs against an isolated tmp photos root + state root, so nothing touches the real
dataset. Covers: create-with-images, empty-name rejection, key collision, non-image
skipping, unrecognized-filename reporting, add-to-existing, and unknown-series 404.
"""

from __future__ import annotations

from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api import deps
from app.main import app


@pytest.fixture()
def env(tmp_path, monkeypatch):
    from app import state

    monkeypatch.setattr(state, "STATE_ROOT", tmp_path / "state")
    (tmp_path / "photos").mkdir()
    monkeypatch.setenv("MORPH_FOURIER_PHOTOS_ROOT", str(tmp_path / "photos"))
    monkeypatch.setattr(deps, "_sam_predictor", None)
    return tmp_path


@pytest.fixture()
def client(env):
    return TestClient(app)


def _jpeg() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (60, 40), (200, 200, 200)).save(buf, format="JPEG")
    return buf.getvalue()


def _img_file(name: str):
    return ("files", (name, _jpeg(), "image/jpeg"))


def test_create_series_writes_images(client, env):
    r = client.post(
        "/api/series",
        data={"name": "Leaves (Top view)"},
        files=[_img_file("Leafus_species_001_1.jpg"), _img_file("Leafus_species_002_1.jpg")],
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["uploaded"] == 2
    assert body["skipped"] == []
    assert body["unrecognized"] == 0
    assert body["series"]["key"] == "leaves_top_view"
    assert body["series"]["photoCount"] == 2
    # Files actually landed under the series folder.
    folder = env / "photos" / "Leaves (Top view)"
    assert sorted(p.name for p in folder.glob("*.jpg")) == [
        "Leafus_species_001_1.jpg",
        "Leafus_species_002_1.jpg",
    ]


def test_create_series_appears_in_listing(client):
    client.post("/api/series", data={"name": "Fossils"}, files=[_img_file("Ammon_10_1.jpg")])
    keys = [s["key"] for s in client.get("/api/series").json()]
    assert "fossils" in keys


def test_create_series_blank_name_rejected(client):
    r = client.post("/api/series", data={"name": "  !!!  "})
    assert r.status_code == 422


def test_create_series_key_collision(client):
    client.post("/api/series", data={"name": "Dorsal"}, files=[_img_file("Aaa_1_1.jpg")])
    r = client.post("/api/series", data={"name": "dorsal"})  # same safe key
    assert r.status_code == 409


def test_non_images_skipped_and_bad_names_flagged(client):
    r = client.post(
        "/api/series",
        data={"name": "Mixed"},
        files=[
            _img_file("Good_species_005_1.jpg"),  # parseable
            _img_file("vacation_photo.jpg"),  # image, but doesn't match naming
            ("files", ("notes.txt", b"hello", "text/plain")),  # not an image
        ],
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["uploaded"] == 2  # both jpgs written
    assert body["skipped"] == ["notes.txt"]  # txt rejected
    assert body["unrecognized"] == 1  # vacation_photo.jpg written but unparseable
    assert body["series"]["photoCount"] == 1  # only the well-named one is a specimen


def test_upload_to_existing_series_grows_count(client):
    client.post("/api/series", data={"name": "Ventral"}, files=[_img_file("Bbb_1_1.jpg")])
    r = client.post("/api/ventral/upload", files=[_img_file("Bbb_2_1.jpg")])
    assert r.status_code == 200, r.text
    assert r.json()["series"]["photoCount"] == 2


def test_upload_unknown_series_404(client):
    r = client.post("/api/does_not_exist/upload", files=[_img_file("Ccc_1_1.jpg")])
    assert r.status_code == 404
