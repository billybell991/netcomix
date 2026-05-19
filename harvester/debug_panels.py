"""
debug_panels.py — download pages from R2 and generate annotated debug images showing detected panels.

Usage:
    python harvester/debug_panels.py
    python harvester/debug_panels.py 3 4 12 19 31 37 43  # specific pages only

Output: test-results/panels_debug/ folder with annotated PNGs.
"""
from __future__ import annotations
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Load .env if present
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

import boto3
import cv2
import numpy as np
from harvest_drive import detect_panels

ISSUE_ID = "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero"
BUCKET = os.environ.get("R2_BUCKET", "netcomix")
ENDPOINT = os.environ.get("R2_ENDPOINT_URL", "https://ad538fc9c2621046b7e268939b6bd200.r2.cloudflarestorage.com")
ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "521fbbe7e83b63190ff8a0df33bab0cd")
SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "1d3d4e2992cfefac7439ab61ff6aa81b2f5e7ae4dff371160a7b050f7a68f900")

OUT_DIR = Path(__file__).parent.parent / "test-results" / "panels_debug"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def s3():
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        region_name="auto",
    )


def draw_panels(img_path: Path, panels, page_num: int) -> Path:
    """Draw panel bounding boxes on the image and save annotated version."""
    img = cv2.imread(str(img_path))
    if img is None:
        print(f"  ! Could not read {img_path}")
        return img_path

    h, w = img.shape[:2]
    colors = [
        (0, 255, 0),    # green
        (0, 128, 255),  # orange
        (255, 0, 0),    # blue
        (0, 0, 255),    # red
        (255, 0, 255),  # magenta
        (0, 255, 255),  # yellow
        (255, 255, 0),  # cyan
        (128, 0, 255),  # purple
        (0, 128, 0),    # dark green
    ]

    annotated = img.copy()

    if not panels:
        # No panels — stamp "FULL PAGE" in red
        cv2.putText(annotated, "FULL PAGE (0 panels)", (30, 80),
                    cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 255), 4, cv2.LINE_AA)
    else:
        for i, p in enumerate(panels):
            color = colors[i % len(colors)]
            # Draw thick rectangle
            cv2.rectangle(annotated, (p.x, p.y), (p.x + p.w, p.y + p.h), color, 6)
            # Draw panel number label with background
            label = str(i + 1)
            font_scale = max(2.0, min(h / 400, 3.5))
            thickness = max(4, int(font_scale * 2))
            (tw, th), bl = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
            tx = p.x + 10
            ty = p.y + th + 15
            # Background box
            cv2.rectangle(annotated, (tx - 5, ty - th - 10), (tx + tw + 5, ty + bl + 5), color, -1)
            # White text
            cv2.putText(annotated, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                        (255, 255, 255), thickness, cv2.LINE_AA)

    # Add page number and panel count at top
    info = f"Page {page_num:02d} — {len(panels)} panel(s)  ({w}x{h})"
    cv2.putText(annotated, info, (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4,
                (255, 255, 255), 4, cv2.LINE_AA)
    cv2.putText(annotated, info, (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4,
                (0, 0, 0), 2, cv2.LINE_AA)

    out_path = OUT_DIR / f"page_{page_num:02d}_panels_{len(panels)}.png"
    cv2.imwrite(str(out_path), annotated)
    return out_path


def main():
    target_pages = None
    if len(sys.argv) > 1:
        target_pages = set(int(a) for a in sys.argv[1:])

    client = s3()

    # List all page JPEGs for this issue in R2
    print(f"Listing R2 pages for {ISSUE_ID}...")
    paginator = client.get_paginator("list_objects_v2")
    # R2 keys are stored as {series_id}/{issue_id}/page-NNN.jpg
    # (matching the DB r2Key format from harvest_r2_staging.py)
    SERIES_ID = "tales-from-the-crypt-v2"
    pages_result = paginator.paginate(Bucket=BUCKET, Prefix=f"{SERIES_ID}/{ISSUE_ID}/page-")
    keys = []
    for page in pages_result:
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(".jpg") or key.endswith(".jpeg"):
                keys.append(key)

    keys.sort()
    print(f"Found {len(keys)} page images")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        results = []
        for i, key in enumerate(keys):
            page_num = i + 1
            if target_pages and page_num not in target_pages:
                continue

            fname = Path(key).name
            local_path = tmp / fname
            print(f"  Downloading page {page_num:02d} ({key})...")
            client.download_file(BUCKET, key, str(local_path))

            w, h, panels, dom_color = detect_panels(local_path)
            out = draw_panels(local_path, panels, page_num)
            print(f"  Page {page_num:02d}: {len(panels)} panel(s) -> {out.name}")
            results.append((page_num, len(panels), panels))

    print(f"\n{'Page':>4}  {'Panels':>6}  Coords")
    print("-" * 80)
    for page_num, count, panels in results:
        coords = "  " + "  ".join(f"({p.x},{p.y},{p.w},{p.h})" for p in panels) if panels else "  FULL PAGE"
        print(f"{page_num:4d}  {count:6d}  {coords}")

    print(f"\nAnnotated images saved to: {OUT_DIR}")


if __name__ == "__main__":
    main()
