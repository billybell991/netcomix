"""
Compare two speech-bubble/text detectors on a sample of pages
from Tales from the Crypt v2 issue 01.

Models tested:
  A) ogkalu/comic-speech-bubble-detector-yolov8m  (general comics)
  B) mayocream/comic-text-detector                (manga-focused)

Run:
    python scripts/test_bubble_models.py

Output:
  - Prints per-page detection counts for each model
  - Saves annotated JPEGs to scripts/bubble_test_out/ for visual inspection
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ISSUE_DIR = Path("public/comics/tales-from-the-crypt-v2/tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero")
OUT_DIR   = Path("scripts/bubble_test_out")
# Test on pages 2-6 (skip cover at index 0)
TEST_PAGES = [1, 2, 3, 4, 5]   # 0-based indices into pages array


def zone_grid(w: int, h: int):
    """Return 6 zone rects as (x, y, w, h) in 2-col × 3-row order."""
    cw = w // 2
    rh = h // 3
    zones = []
    for row in range(3):
        for col in range(2):
            zx = col * cw
            zy = row * rh
            zw = cw if col == 0 else w - cw
            zh = rh if row < 2 else h - 2 * rh
            zones.append((zx, zy, zw, zh))
    return zones


def draw_results(img, zones, detections, title, out_path):
    vis = img.copy()
    colors = [(0, 200, 0), (0, 0, 220), (220, 150, 0),
              (180, 0, 220), (0, 220, 220), (220, 0, 120)]
    # Draw zone borders
    for i, (zx, zy, zw, zh) in enumerate(zones):
        cv2.rectangle(vis, (zx, zy), (zx + zw, zy + zh), colors[i], 3)
        cv2.putText(vis, f"Z{i+1}", (zx + 10, zy + 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, colors[i], 3)
    # Draw detected bubbles
    for (bx, by, bw, bh, conf) in detections:
        cv2.rectangle(vis, (bx, by), (bx + bw, by + bh), (255, 80, 80), 2)
        cx, cy = bx + bw // 2, by + bh // 2
        cv2.circle(vis, (cx, cy), 8, (255, 80, 80), -1)
        cv2.putText(vis, f"{conf:.2f}", (bx, by - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 80, 80), 2)
    # Title bar
    cv2.putText(vis, title, (10, vis.shape[0] - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 3)
    cv2.imwrite(str(out_path), vis)


def run_ogkalu(model, img_path):
    """Run ogkalu YOLOv8 bubble detector."""
    results = model(str(img_path), conf=0.30, iou=0.45, verbose=False)
    boxes = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0])
            boxes.append((x1, y1, x2 - x1, y2 - y1, conf))
    return boxes


def run_mayocream(model, img_path):
    """Run mayocream comic-text-detector (also ultralytics-compatible)."""
    results = model(str(img_path), conf=0.30, iou=0.45, verbose=False)
    boxes = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0])
            boxes.append((x1, y1, x2 - x1, y2 - y1, conf))
    return boxes


def assign_to_zones(detections, zones):
    """
    Returns list of 6 entries.  Each entry is either None (no text) or
    (cx, cy) = center-of-mass of all bubbles whose center falls in that zone.
    """
    zone_hits = [[] for _ in zones]
    for (bx, by, bw, bh, _conf) in detections:
        bcx = bx + bw // 2
        bcy = by + bh // 2
        for i, (zx, zy, zw, zh) in enumerate(zones):
            if zx <= bcx < zx + zw and zy <= bcy < zy + zh:
                zone_hits[i].append((bcx, bcy))
                break   # assign to first matching zone only

    result = []
    for hits in zone_hits:
        if hits:
            avg_cx = int(sum(h[0] for h in hits) / len(hits))
            avg_cy = int(sum(h[1] for h in hits) / len(hits))
            result.append({"cx": avg_cx, "cy": avg_cy, "has_text": True})
        else:
            result.append(None)
    return result


def main():
    from ultralytics import YOLO

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load issue.json
    issue_json = ISSUE_DIR / "issue.json"
    with open(issue_json) as f:
        issue = json.load(f)

    pages = issue["pages"]

    # ---- Load models ----
    print("Loading ogkalu model …")
    try:
        from huggingface_hub import hf_hub_download
        oga_path = hf_hub_download(
            repo_id="ogkalu/comic-speech-bubble-detector-yolov8m",
            filename="comic-speech-bubble-detector.pt",
        )
        model_oga = YOLO(oga_path)
        print(f"  ogkalu loaded from {oga_path}")
    except Exception as e:
        print(f"  ogkalu FAILED: {e}")
        model_oga = None

    print("Loading mayocream model …")
    try:
        mayo_path = hf_hub_download(
            repo_id="mayocream/comic-text-detector",
            filename="comictextdetector.pt",
        )
        model_mayo = YOLO(mayo_path)
        print(f"  mayocream loaded from {mayo_path}")
    except Exception as e:
        print(f"  mayocream FAILED: {e}")
        model_mayo = None

    if not model_oga and not model_mayo:
        sys.exit("Neither model loaded — cannot continue.")

    # ---- Run on test pages ----
    print(f"\n{'Page':<6} {'ogkalu':>8} {'mayocream':>10}")
    print("-" * 28)

    for idx in TEST_PAGES:
        if idx >= len(pages):
            break
        page = pages[idx]
        img_path = ISSUE_DIR / page["file"]
        if not img_path.exists():
            print(f"  {idx+1:>4}  MISSING: {img_path}")
            continue

        img = cv2.imread(str(img_path))
        if img is None:
            print(f"  {idx+1:>4}  UNREADABLE")
            continue

        h, w = img.shape[:2]
        zones = zone_grid(w, h)

        oga_boxes  = run_ogkalu(model_oga, img_path)  if model_oga  else []
        mayo_boxes = run_mayocream(model_mayo, img_path) if model_mayo else []

        print(f"  p{idx+1:02d}  {len(oga_boxes):>6}  {len(mayo_boxes):>8}")

        # Save annotated images
        if model_oga:
            draw_results(img, zones, oga_boxes,
                         f"ogkalu  p{idx+1:02d}  ({len(oga_boxes)} bubbles)",
                         OUT_DIR / f"p{idx+1:02d}_ogkalu.jpg")
        if model_mayo:
            draw_results(img, zones, mayo_boxes,
                         f"mayocream p{idx+1:02d} ({len(mayo_boxes)} bubbles)",
                         OUT_DIR / f"p{idx+1:02d}_mayocream.jpg")

    print(f"\nAnnotated images saved to {OUT_DIR}/")
    print("Open them side-by-side and pick the better model.")


if __name__ == "__main__":
    main()
