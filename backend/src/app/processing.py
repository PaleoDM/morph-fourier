"""Image-processing primitives (SAM, rotation, contour extraction).

The module wiring follows the Morph-Fourier package layout:

- ``PhotoRecord`` is imported as ``from .filenames import PhotoRecord``.
- Path constants point at the backend tree and the configured photos root
  (``MORPH_FOURIER_PHOTOS_ROOT``).

There were no Streamlit imports to strip. Torch / SAM / OpenCV / scikit-image /
scipy are imported lazily inside the functions that need them, so this module
imports cleanly with only numpy installed (Phase 1A does not exercise SAM).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import numpy as np

from .filenames import PhotoRecord

# BACKEND_ROOT points at apps/morph-fourier/backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
APP_ROOT = BACKEND_ROOT.parent  # apps/morph-fourier/
MODELS_DIR = BACKEND_ROOT / "models"
SAM_WEIGHTS_PATH = MODELS_DIR / "sam_vit_b_01ec64.pth"
SAM_MODEL_TYPE = "vit_b"
PHOTOS_ROOT = Path(os.environ.get("MORPH_FOURIER_PHOTOS_ROOT", APP_ROOT / "photos"))

DEFAULT_OUTLINE_POINTS = 1024
CROP_MARGIN_FRACTION = 0.05  # 5% of long-axis length
MIDLINE_FRAC_FOR_AP_HEURISTIC = 0.10  # use middle 10% of width for anterior/posterior check


# ---------- SAM loading ----------


def get_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_sam_predictor(weights_path: Path = SAM_WEIGHTS_PATH, device: Optional[str] = None):
    """Load SAM model and return a SamPredictor instance."""
    from segment_anything import SamPredictor, sam_model_registry

    if not weights_path.exists():
        raise FileNotFoundError(
            f"SAM weights not found at {weights_path}. Run setup.command to download."
        )
    if device is None:
        device = get_device()
    sam = sam_model_registry[SAM_MODEL_TYPE](checkpoint=str(weights_path))
    sam.to(device)
    return SamPredictor(sam), device


# ---------- Image / mask helpers ----------


def load_image_rgb(path: Path) -> np.ndarray:
    """Load image as HxWx3 uint8 RGB numpy array."""
    from PIL import Image, ImageOps

    img = Image.open(path)
    img = ImageOps.exif_transpose(img)  # respect EXIF rotation
    img = img.convert("RGB")
    return np.array(img)


def segment_with_sam(
    predictor,
    image_rgb: np.ndarray,
    seed_points: Optional[list[dict]] = None,
) -> tuple[np.ndarray, float]:
    """Run SAM with point prompts; return (mask, score).

    seed_points: optional list of dicts like {"x": int, "y": int, "label": 0 or 1}.
        label 1 = positive (foreground), label 0 = negative (background).
        If None or empty, defaults to a single positive point at image center.
    """
    predictor.set_image(image_rgb)
    h, w = image_rgb.shape[:2]
    has_user_seeds = bool(seed_points)
    if has_user_seeds:
        point_coords = np.array([[s["x"], s["y"]] for s in seed_points], dtype=np.float32)
        point_labels = np.array([s["label"] for s in seed_points], dtype=np.int32)
    else:
        point_coords = np.array([[w // 2, h // 2]], dtype=np.float32)
        point_labels = np.array([1], dtype=np.int32)

    # With explicit user prompts (especially multiple points or any negatives), SAM does
    # better with multimask_output=False — it commits to one mask that respects the prompts
    # rather than offering three guesses whose ranking by IoU score can prefer a too-small
    # focused mask over the larger object the user actually wants.
    masks, scores, _ = predictor.predict(
        point_coords=point_coords,
        point_labels=point_labels,
        multimask_output=not has_user_seeds,
    )

    if has_user_seeds:
        # Single mask returned — use it directly.
        return masks[0].astype(bool), float(scores[0])

    # No user seeds: pick the best of 3 by score with a sensible-area filter.
    h_total = image_rgb.shape[0] * image_rgb.shape[1]
    candidates = []
    for m, s in zip(masks, scores):
        area = int(m.sum())
        area_frac = area / h_total
        if 0.01 <= area_frac <= 0.85:
            candidates.append((s, area, m))
    if not candidates:
        idx = int(np.argmax([m.sum() for m in masks]))
        return masks[idx].astype(bool), float(scores[idx])
    candidates.sort(key=lambda t: (-t[0], -t[1]))
    score, _, mask = candidates[0]
    return mask.astype(bool), float(score)


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Keep largest connected component; morphological close to fill small holes."""
    from skimage import measure, morphology

    if not mask.any():
        return mask
    labels = measure.label(mask, connectivity=2)
    if labels.max() == 0:
        return mask
    region_sizes = np.bincount(labels.ravel())
    region_sizes[0] = 0
    largest_label = int(np.argmax(region_sizes))
    cleaned = labels == largest_label
    cleaned = morphology.closing(cleaned, footprint=morphology.disk(3))
    return cleaned


def clean_mask_multi_piece(
    mask: np.ndarray,
    n_keep: int = 3,
    min_component_frac: float = 0.005,
    bridge_width_frac: float = 0.03,
) -> np.ndarray:
    """For unfused specimens: keep the top-N largest connected components (above a min size),
    then connect adjacent components with a thick straight line at their closest-point pair.
    Lines preserve each piece's natural concavities and outer boundaries — only the rectangular
    bridge across the gap is added — while still producing a single closed outline for EFA.

    n_keep: maximum number of components to keep (top by area, default 3 for basihyal + 2 thyrohyals)
    min_component_frac: minimum size relative to image area for a component to count (drops SAM noise)
    bridge_width_frac: bridge thickness as a fraction of the min image dim. Tune via UI slider.
    """
    import cv2
    from scipy.spatial.distance import cdist
    from skimage import measure, morphology

    if not mask.any():
        return mask
    labels = measure.label(mask, connectivity=2)
    if labels.max() == 0:
        return mask

    h, w = mask.shape
    total = float(h * w)
    region_sizes = np.bincount(labels.ravel())
    region_sizes[0] = 0  # background

    eligible = np.where(region_sizes / total >= min_component_frac)[0]
    eligible = eligible[eligible > 0]
    if len(eligible) == 0:
        largest = int(np.argmax(region_sizes))
        cleaned = labels == largest
        return morphology.closing(cleaned, footprint=morphology.disk(3))

    eligible = eligible[np.argsort(-region_sizes[eligible])][:n_keep]
    cleaned = np.isin(labels, eligible)

    if len(eligible) == 1:
        return morphology.closing(cleaned, footprint=morphology.disk(3))

    # Order kept components left-to-right by centroid x, then bridge adjacent pairs
    boundaries = []
    for lab in eligible:
        comp_mask = labels == lab
        xs = np.nonzero(comp_mask)[1]
        cx = float(xs.mean())
        contours = measure.find_contours(comp_mask.astype(float), level=0.5)
        if not contours:
            continue
        boundary = max(contours, key=len)  # (N, 2) row, col
        boundary_xy = np.column_stack([boundary[:, 1], boundary[:, 0]])  # x, y
        boundaries.append((cx, boundary_xy))

    boundaries.sort(key=lambda b: b[0])

    bridge_width = max(3, int(min(h, w) * bridge_width_frac))
    cleaned_u8 = cleaned.astype(np.uint8)

    for i in range(len(boundaries) - 1):
        _, b1 = boundaries[i]
        _, b2 = boundaries[i + 1]
        if len(b1) > 600:
            b1 = b1[:: max(1, len(b1) // 600)]
        if len(b2) > 600:
            b2 = b2[:: max(1, len(b2) // 600)]
        dists = cdist(b1, b2)
        i_min, j_min = np.unravel_index(int(np.argmin(dists)), dists.shape)
        p1 = b1[i_min]
        p2 = b2[j_min]
        cv2.line(
            cleaned_u8,
            (int(round(p1[0])), int(round(p1[1]))),
            (int(round(p2[0])), int(round(p2[1]))),
            1,
            thickness=bridge_width,
        )

    return morphology.closing(cleaned_u8.astype(bool), footprint=morphology.disk(3))


def mask_principal_angle_degrees(mask: np.ndarray) -> float:
    """PCA on mask pixel coordinates; return rotation in degrees to align principal axis horizontal."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 10:
        return 0.0
    coords = np.column_stack([xs.astype(np.float64), ys.astype(np.float64)])
    coords -= coords.mean(axis=0)
    cov = np.cov(coords, rowvar=False)
    eigvals, eigvecs = np.linalg.eigh(cov)
    # principal axis = eigenvector with largest eigenvalue
    principal = eigvecs[:, np.argmax(eigvals)]
    angle_rad = np.arctan2(principal[1], principal[0])  # angle of principal axis vs x-axis
    # We want principal axis horizontal -> rotate by -angle
    return float(np.degrees(-angle_rad))


def rotate_image_and_mask(
    image_rgb: np.ndarray, mask: np.ndarray, angle_degrees: float
) -> tuple[np.ndarray, np.ndarray]:
    """Rotate both around their shared center, expanding canvas to fit."""
    import cv2

    h, w = image_rgb.shape[:2]
    center = (w / 2.0, h / 2.0)
    M = cv2.getRotationMatrix2D(center, angle_degrees, 1.0)
    cos = abs(M[0, 0])
    sin = abs(M[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    M[0, 2] += (new_w / 2) - center[0]
    M[1, 2] += (new_h / 2) - center[1]
    rotated_img = cv2.warpAffine(
        image_rgb, M, (new_w, new_h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255)
    )
    rotated_mask = cv2.warpAffine(
        mask.astype(np.uint8), M, (new_w, new_h), flags=cv2.INTER_NEAREST, borderValue=0
    ).astype(bool)
    return rotated_img, rotated_mask


def anterior_is_up(mask: np.ndarray) -> bool:
    """After PCA rotation (principal axis horizontal), check whether anterior is at the top.

    Heuristic: in a narrow vertical band at the midline (mediolateral center), the anterior
    side (basihyal projections) has greater mask extent than the posterior side (empty space
    between diverging thyrohyals). Returns True if anterior is currently up; False means
    we need a 180-deg flip.

    NOTE: This is a legacy anatomy-specific heuristic. Morph-Fourier's learned-orientation
    algorithm (see ``orientation.py``) supersedes it, but the primitive is kept for parity
    and as a base-angle helper.
    """
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return True
    x_min, x_max = xs.min(), xs.max()
    width = x_max - x_min
    mid_x = (x_min + x_max) / 2
    band_half = max(1, int(width * MIDLINE_FRAC_FOR_AP_HEURISTIC / 2))
    band_left = mid_x - band_half
    band_right = mid_x + band_half
    band_mask = mask[:, int(band_left) : int(band_right) + 1]
    if not band_mask.any():
        return True
    band_ys = np.nonzero(band_mask)[0]
    centroid_y = ys.mean()
    # extent above centroid vs below centroid (in pixel space, y increases downward)
    above = (band_ys < centroid_y).sum()  # smaller y -> visually up
    below = (band_ys >= centroid_y).sum()
    # anterior is up if the midline band has more mask area above (smaller y) than below
    return above >= below


def crop_to_mask_bbox(
    image_rgb: np.ndarray, mask: np.ndarray, margin_fraction: float = CROP_MARGIN_FRACTION
) -> tuple[np.ndarray, np.ndarray, tuple[int, int, int, int]]:
    """Crop image + mask to mask bounding box plus a margin."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return image_rgb, mask, (0, 0, image_rgb.shape[1], image_rgb.shape[0])
    x_min, x_max = xs.min(), xs.max()
    y_min, y_max = ys.min(), ys.max()
    width = x_max - x_min
    height = y_max - y_min
    long_axis = max(width, height)
    margin = int(long_axis * margin_fraction)
    h, w = image_rgb.shape[:2]
    x0 = max(0, x_min - margin)
    x1 = min(w, x_max + margin + 1)
    y0 = max(0, y_min - margin)
    y1 = min(h, y_max + margin + 1)
    return image_rgb[y0:y1, x0:x1], mask[y0:y1, x0:x1], (x0, y0, x1, y1)


def extract_outline(
    mask: np.ndarray,
    n_points: int = DEFAULT_OUTLINE_POINTS,
    use_convex_hull: bool = False,
) -> np.ndarray:
    """Extract a closed outline from the mask, resampled to n_points equally-spaced points.

    Default: longest contour from skimage.measure.find_contours (good for connected masks).
    With use_convex_hull=True: convex hull of all mask pixels (one closed polygon encompassing
    every component — used for unfused specimens with multiple disconnected pieces).

    Returns an (n_points, 2) array of (x, y) pixel coordinates in the mask's frame.
    """
    if use_convex_hull:
        import cv2

        ys, xs = np.nonzero(mask)
        if len(xs) < 3:
            raise ValueError("Not enough mask pixels for a convex hull.")
        points = np.column_stack([xs, ys]).astype(np.float32)
        hull = cv2.convexHull(points)
        hull_xy = hull.reshape(-1, 2).astype(np.float64)
        return resample_contour(hull_xy, n_points)

    from skimage import measure

    contours = measure.find_contours(mask.astype(float), level=0.5)
    if not contours:
        raise ValueError("No contours found in mask.")
    contour = max(contours, key=len)
    xy = np.column_stack([contour[:, 1], contour[:, 0]])
    return resample_contour(xy, n_points)


def simplify_contour(contour: np.ndarray, target: int = 30) -> np.ndarray:
    """Douglas-Peucker simplify a closed outline to at most ``target`` control points.

    Used by Stage 4 masking: SAM produces a dense outline (~1024 points); the pen-tool
    anchor editor needs a handful of draggable control points instead. We sweep the
    Douglas-Peucker tolerance upward until the simplified polygon has ``<= target``
    vertices, so the result is a faithful but sparse anchor path.

    Args:
        contour: (N, 2) closed outline (x, y).
        target: maximum number of anchor points to return (ANCHOR_SIMPLIFY_TARGET).

    Returns:
        An (M, 2) array with ``M <= target`` control points, tracing the same shape.
    """
    from skimage.measure import approximate_polygon

    pts = np.asarray(contour, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 2:
        raise ValueError(f"contour must be (N, 2); got shape {pts.shape}")
    if len(pts) <= target:
        return pts

    # Scale the tolerance search to the shape's size so it works at any pixel scale.
    span = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
    if span <= 0:
        return pts[:target]

    tol = span * 1e-4
    simplified = pts
    # approximate_polygon vertex count is monotone-decreasing in tolerance; ramp up.
    for _ in range(40):
        simplified = approximate_polygon(pts, tolerance=tol)
        # approximate_polygon repeats the first vertex at the end for a closed loop;
        # drop the duplicate so the count reflects distinct anchors.
        if len(simplified) > 1 and np.allclose(simplified[0], simplified[-1]):
            simplified = simplified[:-1]
        if len(simplified) <= target:
            break
        tol *= 1.5

    if len(simplified) > target:
        # Fallback: evenly subsample if the sweep never got small enough.
        idx = np.linspace(0, len(simplified) - 1, target).round().astype(int)
        simplified = simplified[np.unique(idx)]
    return simplified


def resample_contour(xy: np.ndarray, n_points: int) -> np.ndarray:
    """Resample a closed polyline to n_points equally-spaced points by arc length."""
    closed = np.vstack([xy, xy[0:1]])
    deltas = np.diff(closed, axis=0)
    seg_lengths = np.sqrt((deltas ** 2).sum(axis=1))
    cum = np.concatenate([[0], np.cumsum(seg_lengths)])
    total = cum[-1]
    if total <= 0:
        raise ValueError("Contour has zero length.")
    targets = np.linspace(0, total, n_points, endpoint=False)
    x_interp = np.interp(targets, cum, closed[:, 0])
    y_interp = np.interp(targets, cum, closed[:, 1])
    return np.column_stack([x_interp, y_interp])


# ---------- Closed centripetal Catmull-Rom (Stage 4 anchor → outline) ----------
#
# The pen-tool editor stores a handful of anchors; the authoritative outline is a
# closed centripetal Catmull-Rom spline THROUGH those anchors, arc-length-resampled
# to DEFAULT_OUTLINE_POINTS. Centripetal parameterization (alpha = 0.5) is chosen
# deliberately: uniform Catmull-Rom overshoots and can self-intersect on unevenly
# spaced anchors (exactly what hand-editing produces), which would inject spurious
# high-frequency harmonics into the EFA. The frontend renders the same spline for
# live display (see konva/catmullRom.ts); this is the saved authority.


def _cr_knot_delta(a: np.ndarray, b: np.ndarray, alpha: float) -> float:
    """Centripetal knot spacing |b - a|**alpha, floored so coincident anchors
    never divide by zero."""
    d = float(np.linalg.norm(b - a)) ** alpha
    return d if d > 1e-9 else 1e-9


def catmull_rom_closed(
    anchors: np.ndarray, samples_per_segment: int = 32, alpha: float = 0.5
) -> np.ndarray:
    """Sample a CLOSED centripetal Catmull-Rom spline through ``anchors``.

    Returns a dense ``(n_anchors * samples_per_segment, 2)`` polyline tracing the
    closed curve (not yet arc-length-even — feed it to :func:`resample_contour`).
    Uses the Barry-Goldman pyramidal formulation so the spline passes exactly
    through every anchor. With fewer than 3 anchors there is no closed curve, so
    the anchors are returned unchanged.
    """
    P = np.asarray(anchors, dtype=np.float64)
    if P.ndim != 2 or P.shape[1] != 2:
        raise ValueError(f"anchors must be (N, 2); got shape {P.shape}")
    n = len(P)
    if n < 3:
        return P.copy()

    out = np.empty((n * samples_per_segment, 2), dtype=np.float64)
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        t0 = 0.0
        t1 = t0 + _cr_knot_delta(p0, p1, alpha)
        t2 = t1 + _cr_knot_delta(p1, p2, alpha)
        t3 = t2 + _cr_knot_delta(p2, p3, alpha)
        # Sample the p1→p2 span (t in [t1, t2)); endpoint excluded so the next
        # segment's first sample lands exactly on the next anchor without a dup.
        ts = np.linspace(t1, t2, samples_per_segment, endpoint=False)
        for j, t in enumerate(ts):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out[i * samples_per_segment + j] = (
                (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2
            )
    return out


def resample_anchor_path(
    anchors: np.ndarray,
    n_points: int = DEFAULT_OUTLINE_POINTS,
    samples_per_segment: int = 32,
    alpha: float = 0.5,
) -> np.ndarray:
    """Anchor control points → closed centripetal Catmull-Rom → arc-length-even
    outline of ``n_points`` (x, y) rows. This is the authoritative resample the
    Stage 4 PUT writes to the outline CSV (see ``api/mask.save_mask``)."""
    dense = catmull_rom_closed(anchors, samples_per_segment, alpha)
    return resample_contour(dense, n_points)


# ---------- Rotation-only computation (for Stage 2 orientation flow) ----------


def compute_rotation_for_photo(record: PhotoRecord, predictor) -> float:
    """Compute the standardized-orientation rotation angle for a raw photo.

    Runs SAM + clean_mask + PCA + anterior-up heuristic, but returns ONLY the
    final rotation angle (in degrees, CCW-positive — same convention as PIL/cv2).
    The image itself is not rotated, cropped, or saved.

    Returns 0.0 on segmentation failure (caller can decide what to do).
    """
    import cv2

    image_rgb = load_image_rgb(record.source_path)
    raw_mask, _ = segment_with_sam(predictor, image_rgb)
    mask = clean_mask(raw_mask)
    if not mask.any():
        return 0.0

    angle = mask_principal_angle_degrees(mask)

    # Apply the rotation just to the mask so we can run the anterior-up check
    h, w = mask.shape
    center = (w / 2.0, h / 2.0)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos = abs(M[0, 0])
    sin = abs(M[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    M[0, 2] += (new_w / 2) - center[0]
    M[1, 2] += (new_h / 2) - center[1]
    rotated_mask = cv2.warpAffine(
        mask.astype(np.uint8),
        M,
        (new_w, new_h),
        flags=cv2.INTER_NEAREST,
        borderValue=0,
    ).astype(bool)

    if not anterior_is_up(rotated_mask):
        angle += 180.0
    return float(angle % 360)


# ---------- Crop suggestion (for Stage 3 crop flow) ----------


def compute_crop_for_photo(
    record: PhotoRecord, rotation_deg: float, predictor, margin_fraction: float = 0.05
) -> list[int]:
    """Apply the rotation (from Stage 2), segment with SAM, return mask bbox + margin
    in the rotated image's coordinate space.

    Returns [x, y, w, h]. Falls back to a centered 60%-of-frame box if SAM returns nothing.
    """
    from PIL import Image, ImageOps

    raw = ImageOps.exif_transpose(Image.open(record.source_path)).convert("RGB")
    rotated = raw.rotate(
        rotation_deg, resample=Image.BILINEAR, expand=True, fillcolor=(245, 245, 245)
    )
    img_rgb = np.array(rotated)
    h, w = img_rgb.shape[:2]

    raw_mask, _ = segment_with_sam(predictor, img_rgb)
    mask = clean_mask(raw_mask)
    if not mask.any():
        # Fallback: centered box covering middle 60% of the frame
        bw, bh = int(w * 0.6), int(h * 0.6)
        return [int((w - bw) / 2), int((h - bh) / 2), bw, bh]

    ys, xs = np.nonzero(mask)
    x_min, x_max = int(xs.min()), int(xs.max())
    y_min, y_max = int(ys.min()), int(ys.max())
    width = x_max - x_min
    height = y_max - y_min
    long_axis = max(width, height)
    margin = int(long_axis * margin_fraction)
    x0 = max(0, x_min - margin)
    y0 = max(0, y_min - margin)
    x1 = min(w, x_max + margin + 1)
    y1 = min(h, y_max + margin + 1)
    return [x0, y0, x1 - x0, y1 - y0]


# ---------- Standardized (rotated + cropped) image (Stage 4 editor background) ----------


def standardized_crop_image(
    record: PhotoRecord,
    rotation_deg: float,
    crop_bbox: Optional[list[int]] = None,
    max_width: Optional[int] = None,
):
    """Return the raw photo rotated (Stage 2) then cropped (Stage 3) as a PIL image.

    This is the exact frame the pen-tool anchor editor draws on and the frame the
    anchor coordinates live in — so serving it (see ``GET /mask/{recordKey}/image``)
    means the client needs no coordinate math: anchor coords == this image's pixels.
    ``crop_bbox`` is ``[x, y, w, h]`` in the rotated-expanded frame; ``None`` returns
    the full rotated frame (used only when no crop exists yet).

    ``max_width`` (optional) downscales the result to that width, preserving aspect,
    when the image is wider — for the Stage 4 / Stage 5 thumbnail grid, which draws a
    full-res crop at ~148px. Anchor/outline coords stay in the full-frame pixel space
    (they scale to fit on the client), so downscaling the *served* pixels is lossless
    for display. The editor requests full resolution (no ``max_width``).
    """
    from PIL import Image, ImageOps

    raw = ImageOps.exif_transpose(Image.open(record.source_path)).convert("RGB")
    rotated = raw.rotate(
        rotation_deg, resample=Image.BILINEAR, expand=True, fillcolor=(245, 245, 245)
    )
    img = rotated if crop_bbox is None else rotated.crop(
        (crop_bbox[0], crop_bbox[1], crop_bbox[0] + crop_bbox[2], crop_bbox[1] + crop_bbox[3])
    )
    if max_width is not None and max_width > 0 and img.width > max_width:
        new_h = max(1, round(img.height * max_width / img.width))
        img = img.resize((max_width, new_h), Image.LANCZOS)
    return img


# ---------- Mask + outline (for Stage 4 masking flow) ----------


def compute_mask_for_photo(
    record: PhotoRecord,
    rotation_deg: float,
    crop_bbox: list[int],
    predictor,
    seed_points: Optional[list[dict]] = None,
    n_outline_points: int = 1024,
    multi_piece: bool = False,
    bridge_width_frac: float = 0.03,
) -> tuple["np.ndarray", "np.ndarray"]:
    """Apply Stage 2 rotation + Stage 3 crop, run SAM, extract outline.

    Returns (mask, outline) where mask is a HxW bool array (cropped-image coords) and
    outline is an (n_outline_points, 2) array of (x, y) in cropped-image coords.

    multi_piece=True: for unfused specimens whose bone is in multiple disconnected pieces.
    Keeps every SAM-segmented component >= 0.5% of the image, then bridges adjacent pieces
    with a thick straight line so the outline is one closed curve. `bridge_width_frac`
    controls the neck thickness (fraction of min image dim).

    Raises ValueError on segmentation failure.
    """
    cropped = standardized_crop_image(record, rotation_deg, crop_bbox)
    img_rgb = np.array(cropped)

    raw_mask, _ = segment_with_sam(predictor, img_rgb, seed_points=seed_points)
    if multi_piece:
        mask = clean_mask_multi_piece(raw_mask, bridge_width_frac=bridge_width_frac)
    else:
        mask = clean_mask(raw_mask)
    if not mask.any():
        raise ValueError("Cleaned mask is empty.")

    # multi_piece masks are already bridged into one connected blob, so the regular
    # longest-contour extraction traces around all pieces with the bridge necks.
    outline = extract_outline(mask, n_points=n_outline_points, use_convex_hull=False)
    return mask, outline
