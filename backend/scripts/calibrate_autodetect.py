"""Phase 11A calibration harness — run the auto pipeline on the real dorsal set.

Not a unit test: this is the empirical instrument that (a) measures the
**automation rate** (how many photos auto-isolate cleanly vs flag), (b) confirms
the 4 spike photos reproduce the §4a findings, and (c) calibrates the match
threshold τ from the real matched-distance distribution.

Run it against a photos root:

    cd backend
    source .venv/bin/activate
    MORPH_FOURIER_PHOTOS_ROOT="./photos" \
        python scripts/calibrate_autodetect.py \
        --series "Series 1" \
        --out /path/to/scratchpad/autodetect_calib

Detection is colour-only (no SAM) so it runs over every photo instantly; SAM
segmentation + matching run over the detected subset. Annotated PNGs (box +
mask overlay) are written to ``--out`` for eyeballing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

# Make ``app.*`` importable when run as a script.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT / "src"))

from app import autodetect as ad  # noqa: E402
from app import processing  # noqa: E402

# The 4 spike photos + their expected FULL-pipeline outcome (detection + SAM-score
# gate). This is the post-11A expectation: border-rejection promotes the mat case
# (267957) from the spike's "fail" to a clean auto, and the SAM-score gate flags the
# warehouse-floor case (237567) instead of silently keeping a garbage grab.
SPIKE_EXPECT = {
    "Cephalorhynchus_commersonii_550449_3.jpg": "auto",   # studio gray ✅
    "Phocoena_phocoena_218733_3.jpg": "auto",             # graph paper ✅
    "Balaenoptera_musculus_237567_1.jpg": "flag",         # warehouse floor → SAM-score gate flags
    "Monodon_267957_2.jpg": "auto",                       # mat+concrete → border-rejection fixes (§4a headroom)
}


def _pipeline_outcome(det, seg) -> str:
    """'auto' when the photo boxed AND segmented cleanly; 'flag' otherwise."""
    if det.box is None or det.flagged:
        return "flag"
    if seg is None or seg.flagged or seg.outline is None:
        return "flag"
    return "auto"


def _genus(name: str) -> str:
    return name.split("_", 1)[0]


def _pick_priming(names: list[str], count: int) -> list[str]:
    """A diversity-nudged priming spread: one photo per genus, round-robin, until
    ``count`` is reached (spec §2 "representative spread, not the first N")."""
    by_genus: dict[str, list[str]] = {}
    for n in sorted(names):
        by_genus.setdefault(_genus(n), []).append(n)
    picked: list[str] = []
    genera = sorted(by_genus)
    i = 0
    while len(picked) < count and any(by_genus.values()):
        g = genera[i % len(genera)]
        if by_genus[g]:
            picked.append(by_genus[g].pop(0))
        i += 1
        if i > len(genera) * 20:
            break
    return picked[:count]


def _annotate(image_rgb, box, mask, out_path: Path) -> None:
    import cv2

    vis = image_rgb.copy()
    if mask is not None and box is not None:
        x1, y1, x2, y2 = box
        overlay = vis[y1:y2, x1:x2]
        red = np.zeros_like(overlay)
        red[..., 0] = 255
        m3 = np.repeat(mask[..., None], 3, axis=2)
        overlay[m3] = (0.5 * overlay[m3] + 0.5 * red[m3]).astype(np.uint8)
        vis[y1:y2, x1:x2] = overlay
    if box is not None:
        cv2.rectangle(vis, (box[0], box[1]), (box[2], box[3]), (0, 200, 0), 4)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), cv2.cvtColor(vis, cv2.COLOR_RGB2BGR))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", default="Series 1")
    ap.add_argument("--out", default=None, help="dir for annotated PNGs")
    ap.add_argument("--priming", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="cap photos (0 = all)")
    ap.add_argument("--no-sam", action="store_true", help="detection-only (skip SAM)")
    args = ap.parse_args()

    photos_root = Path(processing.PHOTOS_ROOT)
    series_dir = photos_root / args.series
    if not series_dir.is_dir():
        print(f"!! series dir not found: {series_dir}")
        print(f"   set MORPH_FOURIER_PHOTOS_ROOT (currently {photos_root})")
        return 2

    names = sorted(p.name for p in series_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    if args.limit:
        # Always include the spike photos in the sample.
        head = [n for n in names if n in SPIKE_EXPECT]
        rest = [n for n in names if n not in SPIKE_EXPECT]
        names = head + rest[: max(0, args.limit - len(head))]
    out_dir = Path(args.out) if args.out else None
    print(f"series: {args.series}  photos: {len(names)}  out: {out_dir}\n")

    # ---- Pass 1: detection (colour only, no SAM) over every photo ----
    print("=" * 78)
    print("PASS 1 — detection (colour auto-box; no SAM)")
    print("=" * 78)
    detected: dict[str, ad.DetectionResult] = {}
    images: dict[str, np.ndarray] = {}
    n_boxed = 0
    for name in names:
        img = processing.load_image_rgb(series_dir / name)
        images[name] = img
        det = ad.detect_target_box(img)
        detected[name] = det
        status = "BOX " if not det.flagged else "flag"
        if not det.flagged:
            n_boxed += 1
        mark = "   [SPIKE]" if name in SPIKE_EXPECT else ""
        print(f"  {status}  fill={det.fill_frac:4.2f} regions={det.n_candidate_regions}  {name}{mark}")

    print(f"\ndetection: {n_boxed}/{len(names)} boxed ({100*n_boxed/len(names):.0f}%), "
          f"{len(names)-n_boxed} flagged  (spike judged post-SAM below)")

    if args.no_sam:
        return 0

    # ---- Pass 2: SAM segmentation over the boxed photos ----
    print("\n" + "=" * 78)
    print("PASS 2 — SAM box-predict segmentation over boxed photos")
    print("=" * 78)
    if not processing.SAM_WEIGHTS_PATH.exists():
        print("!! SAM weights absent — skipping segmentation/matching.")
        return 0
    predictor, device = processing.load_sam_predictor()
    print(f"SAM device: {device}\n")

    segs: dict[str, ad.SegmentationResult] = {}
    outlines: dict[str, np.ndarray] = {}
    for name in names:
        det = detected[name]
        if det.flagged or det.box is None:
            continue
        seg = ad.segment_in_box(images[name], det.box, predictor)
        segs[name] = seg
        if seg.outline is not None:
            outlines[name] = seg.outline
        flag = "" if not seg.flagged else f"  FLAG={seg.flag_reason}"
        print(f"  {name}: score={seg.score:.2f} solidity={seg.solidity:.2f} "
              f"fill={seg.fill_frac:.2f} anchors={0 if seg.anchor_path is None else len(seg.anchor_path)}{flag}")
        if out_dir is not None:
            _annotate(images[name], det.box, seg.mask, out_dir / f"{Path(name).stem}.png")

    clean = [n for n, s in segs.items() if not s.flagged and s.outline is not None]
    print(f"\nsegmentation: {len(clean)}/{len(segs)} boxed photos produced a clean bone outline")

    # ---- Spike reproduction, judged on the FULL pipeline (detection + SAM gate) ----
    print("\n" + "-" * 78)
    print("SPIKE REPRODUCTION (full pipeline: detection + SAM-score gate)")
    print("-" * 78)
    spike_hits = 0
    spike_total = 0
    for name, expect in SPIKE_EXPECT.items():
        if name not in detected:
            continue
        spike_total += 1
        got = _pipeline_outcome(detected[name], segs.get(name))
        ok = got == expect
        spike_hits += int(ok)
        detail = ""
        if name in segs and segs[name] is not None:
            s = segs[name]
            detail = f"(SAM score={s.score:.2f}{'' if not s.flagged else ', flag='+str(s.flag_reason)})"
        print(f"  {'OK ' if ok else 'XX '} {name:44s} expect={expect} got={got} {detail}")
    print(f"\nspike: {spike_hits}/{spike_total} match the post-11A expectation")

    # ---- Pass 3: nearest-of-K matching + τ calibration ----
    print("\n" + "=" * 78)
    print("PASS 3 — nearest-of-K matching + τ calibration")
    print("=" * 78)
    priming = [n for n in _pick_priming(clean, args.priming)]
    exemplars = [
        ad.build_exemplar(name, outlines[name], detected[name].box, 0.0)
        for name in priming
    ]
    print(f"primed {len(exemplars)} diverse exemplars: "
          f"{', '.join(_genus(n) for n in priming)}\n")

    held_out = [n for n in clean if n not in set(priming)]
    distances = []
    for name in held_out:
        outline = outlines[name]
        cand = ad.normalized_efa(outline)
        cand_flip = ad.normalized_efa(ad._rotate_points(outline, 180.0))
        match = ad.match_nearest_exemplar(cand, exemplars, candidate_efa_flipped=cand_flip)
        angle, flip_conf = ad.recover_angle(outline, match.exemplar.outline)
        distances.append(match.distance)
        print(f"  {name:44s} -> {match.exemplar.record_key.split('_')[0]:16s} "
              f"d={match.distance:.3f} angle={angle:6.1f} flipΔ={flip_conf:.3f}")

    if distances:
        d = np.array(distances)
        pct = {p: float(np.percentile(d, p)) for p in (50, 75, 90, 95)}
        print(f"\nmatch-distance distribution (held-out n={len(d)}):")
        print(f"  min={d.min():.3f} median={pct[50]:.3f} p75={pct[75]:.3f} "
              f"p90={pct[90]:.3f} p95={pct[95]:.3f} max={d.max():.3f}")
        tau = round(pct[90], 2)
        print(f"\n  suggested τ (p90 of held-out matched distances) ≈ {tau}")
        print(f"  current MATCH_DISTANCE_THRESHOLD = {ad.MATCH_DISTANCE_THRESHOLD}")
        flagged = int((d > ad.MATCH_DISTANCE_THRESHOLD).sum())
        print(f"  at current τ: {len(d)-flagged}/{len(d)} pass, {flagged} flagged low_confidence")

    # ---- Overall automation-rate summary ----
    print("\n" + "=" * 78)
    print("AUTOMATION-RATE SUMMARY")
    print("=" * 78)
    total = len(names)
    n_gate_flag = sum(1 for s in segs.values() if s.flagged)
    print(f"  total photos:                     {total}")
    print(f"  detection boxed:                  {n_boxed} ({100*n_boxed/total:.0f}%)")
    print(f"  SAM-gate flagged (garbage grab):  {n_gate_flag}")
    print(f"  clean bone outline (auto-isolate):{len(clean)} ({100*len(clean)/total:.0f}%)")
    if distances:
        auto_ok = int((np.array(distances) <= ad.MATCH_DISTANCE_THRESHOLD).sum())
        # zero-touch = detected + clean-segmented + confident-match, over held-out
        print(f"  held-out confident matches:       {auto_ok}/{len(distances)} "
              f"({100*auto_ok/max(1,len(distances)):.0f}% of held-out at τ={ad.MATCH_DISTANCE_THRESHOLD})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
