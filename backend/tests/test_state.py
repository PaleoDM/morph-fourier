"""State round-trip + camelCase-on-disk tests.

For every state model: build → save → load → deep-equal, and assert the on-disk
JSON keys are all camelCase (the binding casing invariant, ROADMAP §3).
"""

from __future__ import annotations

import re
import typing

import pytest

from app import models, state

CAMEL_RE = re.compile(r"^[a-z][a-zA-Z0-9]*$")


def _nested_model_classes(annotation) -> list[type]:
    """MFModel subclasses reachable inside a (possibly generic) type annotation."""
    if isinstance(annotation, type) and issubclass(annotation, models.MFModel):
        return [annotation]
    found: list[type] = []
    for arg in typing.get_args(annotation):
        found.extend(_nested_model_classes(arg))
    return found


def _schema_aliases(model_cls, seen: set | None = None) -> set[str]:
    """Every schema field alias in a model and its nested models (not data keys).

    This is what the camelCase invariant governs: the interface field names, not
    the dynamic keys of ``Record<string, …>`` maps (record keys, specimen ids,
    user-defined taxonomy column names), which are data and may be anything.
    """
    seen = seen if seen is not None else set()
    if model_cls in seen:
        return set()
    seen.add(model_cls)
    aliases: set[str] = set()
    for name, field in model_cls.model_fields.items():
        aliases.add(field.alias or name)
        for sub in _nested_model_classes(field.annotation):
            aliases |= _schema_aliases(sub, seen)
    return aliases


def _sample_models() -> dict[str, models.MFModel]:
    """One populated instance of every persisted state model."""
    return {
        "curation": models.CurationState(
            updated_at="2026-07-06T00:00:00Z",
            photos={
                "dorsal/Balaena_49775_1.jpg": models.PhotoDecision(
                    status="accepted",
                    rejection_reason=None,
                    is_canonical=True,
                    notes="clean specimen",
                ),
                "dorsal/Balaena_49775_2.jpg": models.PhotoDecision(
                    status="rejected", rejection_reason="out of focus"
                ),
            },
        ),
        "orient": models.OrientState(
            updated_at="2026-07-06T00:00:00Z",
            locked_at=None,
            orientations={
                "dorsal/Balaena_49775_1.jpg": models.Orientation(
                    angle_deg=42.5, source="manual", is_priming_example=True
                ),
                "dorsal/Physeter_12345_1.jpg": models.Orientation(
                    angle_deg=190.0, source="learned"
                ),
            },
            learned_reference=models.LearnedReference(
                priming_record_keys=["dorsal/Balaena_49775_1.jpg"],
                reference_coeffs=[0.1, -0.2, 0.3, 0.4, 0.0, 0.9],
                harmonics_used=8,
                built_at="2026-07-06T00:00:00Z",
            ),
        ),
        "crop": models.CropState(
            updated_at="2026-07-06T00:00:00Z",
            crops={
                "dorsal/Balaena_49775_1.jpg": models.CropBox(
                    x1=10.0, y1=20.0, x2=300.0, y2=400.0, source="manual"
                )
            },
        ),
        "mask": models.MaskState(
            updated_at="2026-07-06T00:00:00Z",
            masks={
                "dorsal/Balaena_49775_1.jpg": models.MaskEntry(
                    seed_points=[models.SeedPoint(x=5.0, y=6.0, label=1)],
                    anchor_path=[models.Point(x=1.0, y=2.0), models.Point(x=3.0, y=4.0)],
                    source="manual",
                    outline_point_count=1024,
                    outline_rel_path="state/dorsal/outlines/49775.csv",
                )
            },
        ),
        "efa_settings": models.EfaSettings(
            last_computed_at="2026-07-06T00:00:00Z", harmonics=12, n_specimens_computed=7
        ),
        "pca_settings": models.PcaSettings(
            last_computed_at="2026-07-06T00:00:00Z",
            n_components_retained=5,
            n_components_total=7,
            harmonics_used=12,
        ),
        "taxonomy": models.TaxonomyState(
            updated_at="2026-07-06T00:00:00Z",
            columns=[
                models.TaxonomyColumn(name="Family", type="categorical"),
                models.TaxonomyColumn(name="Mass_kg", type="numeric"),
            ],
            assignments={"49775": {"Family": "Balaenidae", "Mass_kg": 80000.0}},
        ),
        "exemplars": models.ExemplarSet(
            harmonics=8,
            exemplars=[
                models.Exemplar(
                    record_key="dorsal/Balaena_49775_1.jpg",
                    crop_box=models.CropBox(x1=10, y1=20, x2=300, y2=400, source="manual"),
                    angle_deg=42.5,
                    anchor_path=[models.Point(x=1.0, y=2.0), models.Point(x=3.0, y=4.0)],
                    outline=[models.Point(x=1.0, y=2.0), models.Point(x=3.0, y=4.0)],
                    efa_coeffs=[[0.1, -0.2, 0.3, 0.4], [0.0, 0.9, -0.1, 0.2]],
                )
            ],
        ),
        "auto_results": models.AutoResultsState(
            updated_at="2026-07-06T00:00:00Z",
            results={
                "dorsal/Physeter_12345_1.jpg": models.AutoResult(
                    record_key="dorsal/Physeter_12345_1.jpg",
                    source="auto",
                    matched_exemplar_key="dorsal/Balaena_49775_1.jpg",
                    match_distance=0.18,
                    flagged=False,
                ),
                "dorsal/Monodon_6789_1.jpg": models.AutoResult(
                    record_key="dorsal/Monodon_6789_1.jpg",
                    source="auto",
                    flagged=True,
                    flag_reason="detection_failed",
                    flag_detail="warm_background",
                ),
            },
        ),
    }


@pytest.fixture(autouse=True)
def _isolated_state_root(tmp_path, monkeypatch):
    """Redirect the on-disk state tree to a temp dir for each test."""
    monkeypatch.setattr(state, "STATE_ROOT", tmp_path / "state")


@pytest.mark.parametrize("name,model", list(_sample_models().items()))
def test_roundtrip_deep_equal(name, model):
    series = "dorsal"
    expected = model.model_dump(by_alias=True, mode="json")

    written_path = state.save_state(series, name, model)
    assert written_path.exists()
    assert written_path.parent == state.series_dir(series)

    loaded = state.load_state(series, name)
    assert loaded == expected  # deep-equal

    # Re-parsing the loaded JSON reconstructs an equal model (aliases populate).
    reparsed = type(model).model_validate(loaded)
    assert reparsed == model


@pytest.mark.parametrize("name,model", list(_sample_models().items()))
def test_schema_field_aliases_are_camelcase(name, model):
    """Every interface field name (alias) serializes as camelCase."""
    bad = sorted(a for a in _schema_aliases(type(model)) if not CAMEL_RE.match(a))
    assert bad == [], f"non-camelCase schema aliases: {bad}"


@pytest.mark.parametrize("name,model", list(_sample_models().items()))
def test_disk_top_level_keys_are_camelcase(name, model):
    """On disk, the top-level schema keys are exactly the model's camelCase aliases."""
    state.save_state("dorsal", name, model)
    loaded = state.load_state("dorsal", name)

    top_level_aliases = {
        (field.alias or fname) for fname, field in type(model).model_fields.items()
    }
    assert set(loaded.keys()) == top_level_aliases
    assert all(CAMEL_RE.match(k) for k in loaded.keys())


def test_known_aliases_present():
    model = _sample_models()["orient"]
    state.save_state("dorsal", "orient", model)
    loaded = state.load_state("dorsal", "orient")
    assert "schemaVersion" in loaded
    assert "updatedAt" in loaded
    assert "learnedReference" in loaded
    assert "referenceCoeffs" in loaded["learnedReference"]
    assert "harmonicsUsed" in loaded["learnedReference"]
    orientation = next(iter(loaded["orientations"].values()))
    assert "angleDeg" in orientation
    assert "isPrimingExample" in orientation


def test_load_missing_returns_default():
    assert state.load_state("nope", "curation") is None
    assert state.load_state("nope", "curation", default={}) == {}


def test_name_accepts_json_suffix():
    model = _sample_models()["efa_settings"]
    p1 = state.save_state("dorsal", "efa_settings", model)
    p2 = state.state_path("dorsal", "efa_settings.json")
    assert p1 == p2
