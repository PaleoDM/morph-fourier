"""Phase 11A — auto-detect + exemplar-match core.

Two tiers:

- **Pure** (no SAM, no real photos): the colour auto-box on synthetic frames,
  border/warm-background rejection, nearest-of-K matching, and EFA angle recovery
  (the flagged risk §10.2) on primed-vs-held-out synthetic outlines. These run
  everywhere and pin the algorithm's contract.
- **needs_sam**: a single end-to-end ``run_auto`` pass on the ellipse fixture,
  exercising the real ``SamPredictor`` box-predict path. Skips cleanly without
  weights. The broad real-photo automation-rate measurement lives in
  ``scripts/calibrate_autodetect.py``, not here.
"""

from __future__ import annotations

import numpy as np
import pytest

from app import autodetect as ad


# ---------------------------------------------------------------------------
# Synthetic shape helpers
# ---------------------------------------------------------------------------


def _shape(kind: int, n: int = 400) -> np.ndarray:
    """A closed, elongated, asymmetric outline (a well-defined major axis so the
    first-harmonic phase is stable, and no 180° symmetry so the flip is decidable)."""
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    if kind == 0:
        r = 1 + 0.4 * np.cos(t) + 0.2 * np.sin(2 * t) + 0.15 * np.cos(3 * t)
    else:
        r = 1 + 0.3 * np.cos(t) - 0.25 * np.cos(2 * t) + 0.1 * np.sin(3 * t)
    return np.column_stack([r * np.cos(t), r * np.sin(t) * 0.6])


def _rot(points: np.ndarray, deg: float) -> np.ndarray:
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return points @ np.array([[c, -s], [s, c]]).T


def _brown_blob_frame(
    w: int = 400,
    h: int = 300,
    bg=(200, 200, 200),
    blob_center=(200, 150),
    blob_radii=(70, 45),
    touching: bool = False,
    fill_frame: bool = False,
) -> np.ndarray:
    """A neutral-gray frame with one filled brown ellipse (bone-coloured in HSV).

    ``touching`` puts the blob hard against the left/top edge (border-rejection
    case); ``fill_frame`` paints (almost) the whole frame brown (warm-background
    case).
    """
    import cv2

    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:] = bg
    brown = (150, 90, 40)  # RGB — hue ~26°, saturated: passes the bone band
    if fill_frame:
        img[:] = brown
        return img
    if touching:
        center = (blob_radii[0] - 5, blob_radii[1] - 5)
    else:
        center = blob_center
    cv2.ellipse(img, center, blob_radii, 0, 0, 360, brown, -1)
    return img


# ---------------------------------------------------------------------------
# detect_target_box  (pure — colour + morphology + component selection)
# ---------------------------------------------------------------------------


def test_bone_colour_mask_separates_blob_from_neutral_bg():
    img = _brown_blob_frame()
    mask = ad.bone_colour_mask(img)
    # The blob is bone-coloured; the gray background is not.
    assert mask.sum() > 3000
    assert not mask[0, 0]  # a corner is background


def test_detect_boxes_the_blob_on_neutral_background():
    img = _brown_blob_frame(blob_center=(200, 150), blob_radii=(70, 45))
    res = ad.detect_target_box(img)
    assert not res.flagged and res.box is not None
    x1, y1, x2, y2 = res.box
    # Box (bbox + margin) encloses the ellipse [130,105]-[270,195] and stays in-frame.
    assert x1 < 130 and x2 > 270 and y1 < 105 and y2 > 195
    assert 0 <= x1 and x2 <= 400 and 0 <= y1 and y2 <= 300


def test_detect_picks_largest_of_two_blobs():
    """Domain fact: the basihyal complex outsizes the stylohyals → largest wins."""
    import cv2

    img = _brown_blob_frame(blob_center=(120, 150), blob_radii=(70, 45))
    cv2.ellipse(img, (320, 150), (25, 18), 0, 0, 360, (150, 90, 40), -1)  # small "stylohyal"
    res = ad.detect_target_box(img)
    assert not res.flagged
    cx = (res.box[0] + res.box[2]) / 2
    assert cx < 220  # centered on the large left blob, not the small right one


def test_detect_flags_warm_background_fill():
    """A frame that is (almost) entirely bone-coloured = the concrete-floor failure."""
    img = _brown_blob_frame(fill_frame=True)
    res = ad.detect_target_box(img)
    assert res.flagged
    assert res.flag_reason in ("warm_background", "no_bone_colour")


def test_detect_border_rejection_drops_edge_hugging_blob():
    """A warm surface touching the frame edge is rejected → flags instead of boxing it.

    This is the mat/concrete-edge fix (§4a): the only bone-coloured region hugs the
    corner, so after border rejection nothing survives.
    """
    img = _brown_blob_frame(touching=True, blob_radii=(60, 60))
    res = ad.detect_target_box(img)
    assert res.flagged and res.box is None


def test_detect_border_rejection_keeps_interior_bone_over_edge_surface():
    """Mat case: a large edge-touching surface + an interior bone → the interior
    bone survives border rejection and is selected."""
    import cv2

    img = np.zeros((300, 400, 3), dtype=np.uint8)
    img[:] = (200, 200, 200)
    # A warm "mat/concrete" band hugging the bottom edge (touches border → rejected).
    cv2.rectangle(img, (0, 250), (400, 300), (150, 90, 40), -1)
    # The interior bone (does not touch any edge).
    cv2.ellipse(img, (200, 130), (60, 40), 0, 0, 360, (150, 90, 40), -1)
    res = ad.detect_target_box(img)
    assert not res.flagged and res.box is not None
    cy = (res.box[1] + res.box[3]) / 2
    assert cy < 200  # boxed the interior bone, not the bottom band


def test_detect_flags_empty_on_all_neutral_frame():
    img = np.full((300, 400, 3), 210, dtype=np.uint8)  # uniform gray, no bone colour
    res = ad.detect_target_box(img)
    assert res.flagged and res.box is None and res.flag_reason == "no_bone_colour"


# ---------------------------------------------------------------------------
# detect_target_box_learned  (prime-learned appearance model — the generic path)
# ---------------------------------------------------------------------------


def _colorless_blob_frame(w=400, h=300, center=(200, 150), radii=(70, 45)):
    """A low-saturation grey ellipse on a dark background — a foram-like specimen the
    fixed bone-colour band (S≥45) is blind to."""
    import cv2

    img = np.full((h, w, 3), 30, dtype=np.uint8)  # near-black background
    cv2.ellipse(img, center, radii, 0, 0, 360, (150, 150, 150), -1)  # colorless grey
    return img


def test_learned_detector_boxes_colorless_blob_the_colour_path_misses():
    """The appearance model, primed on one specimen, finds a colorless target and boxes
    it tightly — the whole reason the learned path exists (colour heuristic → nothing)."""
    import cv2

    center, radii = (200, 150), (70, 45)
    img = _colorless_blob_frame(center=center, radii=radii)

    # The fixed colour heuristic is blind to the low-saturation specimen.
    assert ad.detect_target_box(img).flagged

    # Prime the model from this specimen: crop = blob bbox, polygon = its outline (box frame).
    x1, y1 = center[0] - radii[0], center[1] - radii[1]
    x2, y2 = center[0] + radii[0], center[1] + radii[1]
    poly_box = cv2.ellipse2Poly(center, radii, 0, 0, 360, 6).astype(np.float64) - np.array([x1, y1])
    model = ad.build_appearance_model([(img, (x1, y1, x2, y2), poly_box)])
    assert model is not None

    res = ad.detect_target_box_learned(img, model)
    assert not res.flagged and res.box is not None
    bx1, by1, bx2, by2 = res.box
    # Centered on the blob, and TIGHT (near the ellipse bbox area, not a loose/frame box).
    assert abs((bx1 + bx2) / 2 - center[0]) < 12 and abs((by1 + by2) / 2 - center[1]) < 12
    ellipse_area = (2 * radii[0]) * (2 * radii[1])
    assert ellipse_area * 0.85 <= (bx2 - bx1) * (by2 - by1) <= ellipse_area * 1.6


def test_learned_margin_is_no_looser_than_colour_default():
    """The learned box hugs the specimen (points, not the box, do the anti-rectangle work,
    so it needn't be razor-tight — but it should never be looser than the colour path)."""
    assert ad.LEARNED_CROP_MARGIN_FRAC <= ad.CROP_MARGIN_FRAC


def test_build_appearance_model_returns_none_without_foreground():
    """No usable foreground (degenerate polygon) → None, so the caller falls back to colour."""
    img = _colorless_blob_frame()
    assert ad.build_appearance_model([(img, (0, 0, 10, 10), np.array([[0.0, 0.0], [1.0, 1.0]]))]) is None


def test_appearance_point_prompts_seed_positive_inside_negative_on_corners():
    """The learned P(target) map yields positive points inside the specimen and negative
    points at the box corners — the signal that stops SAM grabbing the crop rectangle."""
    import cv2

    center, radii = (200, 150), (70, 45)
    img = _colorless_blob_frame(center=center, radii=radii)
    x1, y1 = center[0] - radii[0] - 20, center[1] - radii[1] - 20
    x2, y2 = center[0] + radii[0] + 20, center[1] + radii[1] + 20
    poly = cv2.ellipse2Poly(center, radii, 0, 0, 360, 6).astype(np.float64) - np.array(
        [center[0] - radii[0], center[1] - radii[1]]
    )
    model = ad.build_appearance_model([(img, (center[0] - radii[0], center[1] - radii[1],
                                               center[0] + radii[0], center[1] + radii[1]), poly)])

    coords, labels = ad.appearance_point_prompts(img, (x1, y1, x2, y2), model)
    assert coords is not None and labels is not None
    pos = coords[labels == 1]
    neg = coords[labels == 0]
    assert len(pos) >= 1 and len(neg) >= 4  # at least the four box corners
    # Every positive point lands inside the ellipse (specimen); the corners are negative.
    for px, py in pos:
        assert ((px - center[0]) / radii[0]) ** 2 + ((py - center[1]) / radii[1]) ** 2 <= 1.05
    corners = {(x1 + 1, y1 + 1), (x2 - 1, y1 + 1), (x1 + 1, y2 - 1), (x2 - 1, y2 - 1)}
    assert corners <= {(int(x), int(y)) for x, y in neg}


def test_box_center_prompts_centre_positive_corners_negative():
    """Prime/Review geometric prompts (no model): centre is foreground, corners are
    background — the signal that lets SAM segment a snugly-drawn box instead of rejecting."""
    box = (100, 50, 300, 250)
    coords, labels = ad.box_center_prompts(box)
    pos = coords[labels == 1]
    neg = coords[labels == 0]
    assert len(pos) >= 1 and len(neg) == 4
    pos_set = {(int(x), int(y)) for x, y in pos}
    assert (200, 150) in pos_set  # the box centre is a positive point
    for px, py in pos:  # every positive lies strictly inside the box
        assert 100 < px < 300 and 50 < py < 250
    assert {(102, 52), (298, 52), (102, 248), (298, 248)} == {(int(x), int(y)) for x, y in neg}


# ---------------------------------------------------------------------------
# segment_in_box gating  (pure — fake predictor, no SAM weights needed)
# ---------------------------------------------------------------------------


class _FakePredictor:
    """Stand-in for SamPredictor returning a preset (mask, score) for any box."""

    def __init__(self, mask: np.ndarray, score: float):
        self._mask = mask
        self._score = score

    def set_image(self, image_rgb):  # noqa: D401 - trivial
        self._h, self._w = image_rgb.shape[:2]

    def predict(self, box=None, point_coords=None, point_labels=None, multimask_output=False):
        return self._mask[None, ...], np.array([self._score], dtype=np.float32), None


def _full_frame_mask(h, w, box, draw):
    """Build a full-frame bool mask; ``draw(m)`` paints the object in-place."""
    import cv2

    m = np.zeros((h, w), dtype=np.uint8)
    draw(cv2, m)
    return m.astype(bool)


def test_segment_flags_low_sam_score():
    import cv2

    h, w = 300, 400
    box = (100, 80, 300, 240)
    mask = _full_frame_mask(h, w, box, lambda cv, m: cv.ellipse(m, (200, 150), (60, 40), 0, 0, 360, 1, -1))
    seg = ad.segment_in_box(np.zeros((h, w, 3), np.uint8), box, _FakePredictor(mask, 0.43))
    assert seg.flagged and seg.flag_reason == "low_sam_score"


def test_segment_flags_scale_card_rectangle():
    """A high-solidity rectangle filling the box = the scale card, not a bone."""
    h, w = 300, 400
    box = (100, 80, 300, 240)
    mask = _full_frame_mask(h, w, box, lambda cv, m: cv.rectangle(m, (102, 82), (298, 238), 1, -1))
    seg = ad.segment_in_box(np.zeros((h, w, 3), np.uint8), box, _FakePredictor(mask, 0.99))
    assert seg.flagged and seg.flag_reason == "scale_card"


def test_segment_accepts_clean_bone_and_returns_cropped_anchors():
    import cv2

    h, w = 300, 400
    box = (100, 80, 300, 240)
    # An irregular (low-solidity) blob well inside the box = a plausible bone.
    def draw(cv, m):
        cv.ellipse(m, (200, 150), (70, 40), 0, 0, 360, 1, -1)
        cv.ellipse(m, (150, 150), (20, 60), 0, 0, 360, 0, -1)  # bite a concavity

    mask = _full_frame_mask(h, w, box, draw)
    seg = ad.segment_in_box(np.zeros((h, w, 3), np.uint8), box, _FakePredictor(mask, 0.98))
    assert not seg.flagged and seg.outline is not None
    assert 3 <= len(seg.anchor_path) <= ad.ANCHOR_SIMPLIFY_TARGET
    # Anchor coords live in the cropped (box) frame → within box dimensions.
    assert seg.anchor_path[:, 0].max() <= (box[2] - box[0])
    assert seg.anchor_path[:, 1].max() <= (box[3] - box[1])


def test_segment_flags_empty_mask():
    h, w = 300, 400
    box = (100, 80, 300, 240)
    mask = np.zeros((h, w), dtype=bool)
    seg = ad.segment_in_box(np.zeros((h, w, 3), np.uint8), box, _FakePredictor(mask, 0.99))
    assert seg.flagged and seg.flag_reason == "segmentation_failed"


# ---------------------------------------------------------------------------
# Exemplar building + nearest-of-K matching  (pure)
# ---------------------------------------------------------------------------


def test_build_exemplar_stores_normalized_efa_and_outline():
    outline = _shape(0)
    ex = ad.build_exemplar("s/a.jpg", outline, (0, 0, 100, 100), 12.0)
    assert ex.efa_coeffs.shape == (ad.MATCH_HARMONICS, 4)
    assert ex.outline.shape == outline.shape
    assert ex.anchor_path.ndim == 2 and ex.anchor_path.shape[1] == 2
    assert ex.angle_deg == 12.0 and ex.crop_box == (0, 0, 100, 100)


def test_match_nearest_picks_same_shape_not_the_other():
    ex0 = ad.build_exemplar("k0", _shape(0), (0, 0, 1, 1), 0.0)
    ex1 = ad.build_exemplar("k1", _shape(1), (0, 0, 1, 1), 0.0)
    # A fresh instance of shape-0 at a different rotation should match ex0.
    cand = _rot(_shape(0), 63.0)
    cand_efa = ad.normalized_efa(cand)
    cand_flip = ad.normalized_efa(_rot(cand, 180.0))
    res = ad.match_nearest_exemplar(cand_efa, [ex1, ex0], candidate_efa_flipped=cand_flip)
    assert res.exemplar is ex0
    assert not res.flagged  # same shape → small distance, under τ


def test_match_flip_invariance_matters():
    """Without the flipped candidate, a 180°-rotated candidate reads as far from its
    true exemplar; passing the flip restores the match. Guards the §4-step-4 note."""
    ex0 = ad.build_exemplar("k0", _shape(0), (0, 0, 1, 1), 0.0)
    cand = _rot(_shape(0), 180.0)
    cand_efa = ad.normalized_efa(cand)
    d_noflip = ad.efa_distance(cand_efa, ex0.efa_coeffs)
    cand_flip = ad.normalized_efa(_rot(cand, 180.0))
    res = ad.match_nearest_exemplar(cand_efa, [ex0], candidate_efa_flipped=cand_flip)
    assert res.distance < d_noflip
    assert res.distance < 1e-6  # flipped candidate == exemplar shape


def test_match_flags_low_confidence_beyond_threshold():
    ex0 = ad.build_exemplar("k0", _shape(0), (0, 0, 1, 1), 0.0)
    far = ad.normalized_efa(_shape(1))  # a genuinely different shape
    res = ad.match_nearest_exemplar(far, [ex0], threshold=0.05)
    assert res.flagged and res.distance > 0.05


def test_match_empty_exemplar_set_flags():
    res = ad.match_nearest_exemplar(ad.normalized_efa(_shape(0)), [])
    assert res.exemplar is None and res.flagged


# ---------------------------------------------------------------------------
# Angle recovery  (pure — the §10.2 risk)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("true_angle", [20.0, 75.0, 130.0, 200.0, 285.0, 340.0])
def test_recover_angle_reorients_candidate_to_exemplar(true_angle):
    """EFA-phase recovery returns the rotation that maps the candidate back onto
    the exemplar's orientation, including the 180° flip — to numerical precision."""
    exemplar = _shape(0)  # "correctly oriented"
    candidate = _rot(exemplar, true_angle)  # same shape, unknown rotation
    angle, flip_conf = ad.recover_angle(candidate, exemplar)

    # Applying the recovered angle should align candidate to exemplar.
    realigned = ad._rotate_points(candidate, angle)
    resid = ad.efa_distance(ad.normalized_efa(realigned), ad.normalized_efa(exemplar))
    assert resid < 1e-6
    # Recovered angle ≈ -true_angle (mod 360).
    err = (angle - (-true_angle) + 180) % 360 - 180
    assert abs(err) < 0.5
    assert flip_conf > 0  # the flip was decided, not a coin toss


def test_recover_angle_resolves_180_flip():
    """A candidate at +180° vs +0° must recover different angles (the flip is real)."""
    exemplar = _shape(0)
    a0, _ = ad.recover_angle(_rot(exemplar, 0.0), exemplar)
    a180, _ = ad.recover_angle(_rot(exemplar, 180.0), exemplar)
    diff = (a0 - a180 + 180) % 360 - 180
    assert abs(abs(diff) - 180) < 1.0


@pytest.mark.parametrize("display", [15.0, 90.0, 200.0, 315.0])
def test_orient_for_display_round_trips_to_display_angle(display):
    """The Prime save geometry: orienting a box outline at display angle ``D`` and
    then recovering it (as ``run_auto`` would when matching a later candidate) yields
    ``D`` back via ``to_display_angle``. Pins that priming at ``D`` and auto-orienting
    to that exemplar are inverse — no sign drift between Prime and Automate."""
    box = _shape(0)
    oriented = ad.orient_for_display(box, display)
    recovered, flip_conf = ad.recover_angle(box, oriented)
    err = (ad.to_display_angle(recovered) - display + 180) % 360 - 180
    assert abs(err) < 0.5
    assert flip_conf > 0  # the flip was decided, not a coin toss


# ---------------------------------------------------------------------------
# Display-angle sign — the 11B OPEN RISK (crop-before-orient, y-down frame)
# ---------------------------------------------------------------------------


def _asym_blob_image(w: int = 500, h: int = 500) -> np.ndarray:
    """A brown, strongly-asymmetric blob (clear major axis + decisive 180° flip)
    on a neutral frame — so ``bone_colour_mask`` isolates it and the recovered
    orientation is well-defined."""
    import cv2

    img = np.full((h, w, 3), 210, dtype=np.uint8)
    pts = np.array(
        [[250, 70], [320, 110], [340, 190], [300, 250], [270, 330],
         [255, 410], [245, 330], [235, 250], [200, 200], [190, 130]],
        np.int32,
    )
    cv2.fillPoly(img, [pts], (150, 90, 40))
    cv2.circle(img, (300, 120), 45, (150, 90, 40), -1)  # big head lobe (breaks symmetry)
    return img


def _outline_of(img_rgb: np.ndarray) -> np.ndarray:
    from app import processing

    mask = processing.clean_mask(ad.bone_colour_mask(img_rgb))
    return processing.extract_outline(mask, n_points=400)


def _pil_rotate(img_rgb: np.ndarray, deg: float) -> np.ndarray:
    """PIL ``rotate(deg, expand=True)`` — the exact machinery the pipeline uses
    (``processing.standardized_crop_image`` + the mirroring ``konva/expand.ts``)."""
    from PIL import Image

    return np.array(
        Image.fromarray(img_rgb).rotate(
            deg, resample=Image.BILINEAR, expand=True, fillcolor=(210, 210, 210)
        )
    )


def _fill_iou(oa: np.ndarray, ob: np.ndarray, size: int = 200) -> float:
    """Rasterize two outlines centroid-aligned + scale-normalized → IoU.

    Rotation-SENSITIVE (unlike normalized-EFA distance, which is rotation-
    invariant and only catches flips): IoU is high only when orientation AND
    flip both match, so it certifies "reoriented, not mirrored/inverted."
    """
    import cv2

    def raster(o: np.ndarray) -> np.ndarray:
        o = np.asarray(o, float)
        o = o - o.mean(0)
        o = o / np.abs(o).max() * (size * 0.45) + size / 2
        m = np.zeros((size, size), np.uint8)
        cv2.fillPoly(m, [o.astype(np.int32)], 1)
        return m.astype(bool)

    a, b = raster(oa), raster(ob)
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


def test_to_display_angle_negates_mod_360():
    assert ad.to_display_angle(0.0) == 0.0
    assert ad.to_display_angle(25.0) == 335.0
    assert ad.to_display_angle(340.0) == 20.0


def test_pil_rotate_realises_rotate_points_with_negated_sign():
    """Pure geometric identity behind the resolution: an image rotation of ``-a``
    (PIL) reproduces ``_rotate_points(+a)`` in outline coords. This is the y-down
    frame flip that bit crop; ``to_display_angle`` negates for exactly this reason."""
    base = _asym_blob_image()
    outline = _outline_of(base)
    for a in (30.0, 110.0, 250.0):
        pts_rot = ad._rotate_points(outline, a)
        pil_rot = _outline_of(_pil_rotate(base, -a))
        assert _fill_iou(pts_rot, pil_rot) > 0.9


@pytest.mark.parametrize("true_disp", [25.0, 70.0, 300.0, 340.0])
def test_recover_angle_display_sign_reorients(true_disp):
    """End-to-end angle-sign check on a primed pair (the §10.2 risk).

    Exemplar = the correctly-oriented blob. Candidate = the same specimen
    photographed rotated by ``true_disp``. Recover the angle, convert with
    ``to_display_angle``, apply it as a PIL image rotation, and confirm the
    specimen comes out ORIENTED (high IoU to the exemplar) — while the un-negated
    angle would mirror/invert it (low IoU). Angles avoid the ~180° flip-ambiguous
    zone so the flip decision is unambiguous and the test pins the SIGN, not the
    flip robustness (covered separately)."""
    base = _asym_blob_image()
    exemplar_outline = _outline_of(base)

    candidate_img = _pil_rotate(base, true_disp)
    candidate_outline = _outline_of(candidate_img)
    recovered, flip_conf = ad.recover_angle(candidate_outline, exemplar_outline)
    assert flip_conf > 0

    display = ad.to_display_angle(recovered)
    reoriented = _outline_of(_pil_rotate(candidate_img, display))
    mirrored = _outline_of(_pil_rotate(candidate_img, recovered))  # un-negated (wrong)

    assert _fill_iou(reoriented, exemplar_outline) > 0.90  # reoriented, upright
    assert _fill_iou(mirrored, exemplar_outline) < 0.60    # +angle would flip it


def test_recover_angle_pca_fallback_agrees_with_efa():
    """The PCA fallback recovers the same re-orientation on a well-elongated shape."""
    exemplar = _shape(0)
    candidate = _rot(exemplar, 110.0)
    a_efa, _ = ad.recover_angle(candidate, exemplar)
    a_pca, _ = ad.recover_angle_pca(candidate, exemplar)
    diff = (a_efa - a_pca + 180) % 360 - 180
    assert abs(diff) < 2.0


# ---------------------------------------------------------------------------
# End-to-end run_auto over a real SamPredictor  (needs_sam)
# ---------------------------------------------------------------------------


@pytest.mark.needs_sam
def test_run_auto_end_to_end_on_brown_blob():
    """detect → SAM box-predict → match → recover over the real predictor.

    The brown blob is the sole bone-coloured region on a neutral frame, so
    detection boxes it, SAM segments it, and (with itself primed as the exemplar)
    the match is exact and an angle comes back."""
    from app import processing

    if not processing.SAM_WEIGHTS_PATH.exists():
        pytest.skip("SAM weights not present")

    predictor, _ = processing.load_sam_predictor()
    img = _brown_blob_frame(blob_center=(200, 150), blob_radii=(80, 55))

    # First segment the blob to build an exemplar from the real SAM outline.
    det = ad.detect_target_box(img)
    assert det.box is not None
    seg = ad.segment_in_box(img, det.box, predictor)
    assert not seg.flagged and seg.outline is not None
    assert 3 <= len(seg.anchor_path) <= ad.ANCHOR_SIMPLIFY_TARGET

    exemplar = ad.build_exemplar("blob", seg.outline, det.box, 0.0)
    outcome = ad.run_auto(img, [exemplar], predictor, record_key="blob")
    assert not outcome.flagged
    assert outcome.match is not None and outcome.match.exemplar is exemplar
    assert outcome.angle_deg is not None
