"""Series discovery: sanitization, collision detection, unparseable handling."""

from __future__ import annotations

import pytest

from app import state
from app.filenames import (
    SeriesKeyCollisionError,
    discover_series,
    safe_key,
)


def _touch(folder, *names):
    folder.mkdir(parents=True, exist_ok=True)
    for n in names:
        (folder / n).write_bytes(b"")  # content irrelevant — parser reads names only


# ---------- safe_key sanitization ----------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Dorsal", "dorsal"),
        ("Fused B-T (Dorsal view)", "fused_b_t_dorsal_view"),
        ("  Ventral!!  ", "ventral"),
        ("A/B\\C", "a_b_c"),
        ("already_safe_123", "already_safe_123"),
    ],
)
def test_safe_key(raw, expected):
    assert safe_key(raw) == expected


# ---------- parsing + discovery ----------


def test_discover_parses_valid_and_surfaces_unparseable(tmp_path):
    root = tmp_path / "photos"
    _touch(
        root / "Dorsal",
        "Balaena_49775_1.jpg",
        "Physeter_macrocephalus_A123_2.png",
        "IMG_random_photo.jpg",  # does not match the parser → unparseable
        ".DS_Store",  # hidden → ignored entirely
        "notes.txt",  # non-image → ignored entirely
    )

    series = discover_series(root)
    assert len(series) == 1
    s = series[0]
    assert s.key == "dorsal"
    assert s.display_name == "Dorsal"

    # Two valid files parsed; the mis-named JPEG surfaced, never dropped.
    assert s.photo_count == 2
    parsed_names = {r.filename for r in s.records}
    assert parsed_names == {"Balaena_49775_1.jpg", "Physeter_macrocephalus_A123_2.png"}

    assert len(s.unparseable) == 1
    assert s.unparseable[0].filename == "IMG_random_photo.jpg"
    assert s.unparseable[0].series_key == "dorsal"


def test_default_institution_is_empty(tmp_path):
    root = tmp_path / "photos"
    _touch(root / "Dorsal", "Balaena_49775_1.jpg")
    rec = discover_series(root)[0].records[0]
    assert rec.specimen_id == "49775"  # no institution baked in
    assert rec.specimen_id_safe == "49775"
    assert rec.specimen_key == "49775__dorsal"
    assert rec.record_key == "dorsal/Balaena_49775_1.jpg"
    assert rec.label == "Balaena sp."


def test_institution_prefix_parameter(tmp_path):
    root = tmp_path / "photos"
    _touch(root / "Dorsal", "Balaena_mysticetus_49775_1.jpg")
    rec = discover_series(root, institution_code="USNM")[0].records[0]
    assert rec.specimen_id == "USNM 49775"
    assert rec.specimen_id_safe == "USNM_49775"
    assert rec.label == "Balaena mysticetus"


def test_collision_raises(tmp_path):
    root = tmp_path / "photos"
    _touch(root / "Dorsal", "Balaena_49775_1.jpg")
    _touch(root / "dorsal!", "Balaena_49775_1.jpg")  # sanitizes to same key "dorsal"
    with pytest.raises(SeriesKeyCollisionError):
        discover_series(root)


def test_missing_root_returns_empty(tmp_path):
    assert discover_series(tmp_path / "does_not_exist") == []


def test_multi_photo_grouping(tmp_path):
    root = tmp_path / "photos"
    _touch(
        root / "Dorsal",
        "Balaena_49775_1.jpg",
        "Balaena_49775_2.jpg",
        "Physeter_12345_1.jpg",
    )
    s = discover_series(root)[0]
    keys = {r.specimen_key for r in s.records}
    assert keys == {"49775__dorsal", "12345__dorsal"}


def test_state_discover_series_uses_configured_root(tmp_path, monkeypatch):
    root = tmp_path / "photos"
    _touch(root / "Ventral", "Balaena_49775_1.jpg")
    monkeypatch.setenv("MORPH_FOURIER_PHOTOS_ROOT", str(root))
    series = state.discover_series()
    assert [s.key for s in series] == ["ventral"]
