"""
Add zone_text_centers to every page in a single issue.json using the
ogkalu/comic-speech-bubble-detector-yolov8m model.

Usage:
    python scripts/apply_zone_text_centers.py <issue_dir>

Example:
    python scripts/apply_zone_text_centers.py \
        public/comics/tales-from-the-crypt-v2/tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero

What it does:
  - Skips page 0 (cover) — always leaves zone_text_centers absent for the cover.
  - For every other page: runs the bubble detector, assigns each detection to a
    zone by its center point, averages the centers of all bubbles in the same zone.
  - Writes zone_text_centers: [{cx, cy} or null, ...] (6 entries) to each page.
  - Backs up the original issue.json to issue.json.ztc_bak before overwriting.

The reader (library.ts::applyZoneGrid) already understands this field.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ZONE_COLS = 2
ZONE_ROWS = 3
CONF = 0.30
IOU  = 0.45


def zone_grid(w: int, h: int):
    """Return list of 6 (x, y, w, h) zone rects in TL→TR→ML→MR→BL→BR order."""
    col_w = w // ZONE_COLS
    row_h = h // ZONE_ROWS
    zones = []
    for row in range(ZONE_ROWS):
        for col in range(ZONE_COLS):
            zx = col * col_w
            zy = row * row_h
            zw = col_w if col < ZONE_COLS - 1 else w - zx
            zh = row_h if row < ZONE_ROWS - 1 else h - zy
            zones.append((zx, zy, zw, zh))
    return zones


def detect_bubbles(model, img_path: Path) -> list:
    """Run the model, return list of (x1, y1, x2, y2, conf)."""
    results = model(str(img_path), conf=CONF, iou=IOU, verbose=False)
    boxes = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0])
            boxes.append((x1, y1, x2, y2, conf))
    return boxes


def compute_zone_centers(boxes: list, zones: list) -> list:
    """
    Returns list of 6 entries: {cx, cy} dict or None.
    Each bubble is assigned to the zone whose area contains its center point.
    Zones with multiple bubbles use the center-of-mass of all bubble centers.
    """
    hits = [[] for _ in zones]
    for (x1, y1, x2, y2, _conf) in boxes:
        bcx = (x1 + x2) // 2
        bcy = (y1 + y2) // 2
        for i, (zx, zy, zw, zh) in enumerate(zones):
            if zx <= bcx < zx + zw and zy <= bcy < zy + zh:
                hits[i].append((bcx, bcy))
                break   # one zone per bubble

    result = []
    for zone_hits in hits:
        if zone_hits:
            avg_cx = int(round(sum(p[0] for p in zone_hits) / len(zone_hits)))
            avg_cy = int(round(sum(p[1] for p in zone_hits) / len(zone_hits)))
            result.append({"cx": avg_cx, "cy": avg_cy})
        else:
            result.append(None)
    return result


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    issue_dir = Path(sys.argv[1])
    issue_json_path = issue_dir / "issue.json"

    if not issue_json_path.exists():
        sys.exit(f"ERROR: issue.json not found at {issue_json_path}")

    # Load model
    from ultralytics import YOLO
    from huggingface_hub import hf_hub_download

    print("Loading ogkalu/comic-speech-bubble-detector-yolov8m …")
    model_path = hf_hub_download(
        repo_id="ogkalu/comic-speech-bubble-detector-yolov8m",
        filename="comic-speech-bubble-detector.pt",
    )
    model = YOLO(model_path)
    print("  Model loaded.\n")

    # Load issue.json
    with open(issue_json_path, encoding="utf-8") as f:
        issue = json.load(f)

    pages = issue["pages"]
    total = len(pages)
    skipped = 0
    processed = 0

    for idx, page in enumerate(pages):
        # Cover (index 0) always stays blank — no zone snaps.
        if idx == 0:
            page.pop("zone_text_centers", None)
            skipped += 1
            continue

        img_path = issue_dir / page["file"]
        if not img_path.exists():
            print(f"  [WARN] p{idx+1:03d}: image not found — skipping")
            page.pop("zone_text_centers", None)
            skipped += 1
            continue

        w, h = page.get("width", 0), page.get("height", 0)
        if not w or not h:
            print(f"  [WARN] p{idx+1:03d}: zero dimensions — skipping")
            page.pop("zone_text_centers", None)
            skipped += 1
            continue

        zones = zone_grid(w, h)
        boxes = detect_bubbles(model, img_path)
        centers = compute_zone_centers(boxes, zones)

        page["zone_text_centers"] = centers

        n_text = sum(1 for c in centers if c is not None)
        bubble_word = "bubble" if len(boxes) == 1 else "bubbles"
        print(f"  p{idx+1:03d}: {len(boxes):2d} {bubble_word} → {n_text}/6 zones have text")
        processed += 1

    # Backup original before overwriting
    bak_path = issue_json_path.with_suffix(".json.ztc_bak")
    if not bak_path.exists():
        import shutil
        shutil.copy2(issue_json_path, bak_path)
        print(f"\nBackup saved: {bak_path}")

    with open(issue_json_path, "w", encoding="utf-8") as f:
        json.dump(issue, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {processed} pages updated, {skipped} skipped.")
    print(f"Wrote: {issue_json_path}")


if __name__ == "__main__":
    main()
