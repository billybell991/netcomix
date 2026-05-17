"""
Debug script: speech-balloon-based panel detection for page 6
(dark background, diagonal gutters — projection-cut yields 0 panels).

Ground-truth bounding boxes from pinpoint tool:
  Panel 1: (100, 52)  → (1059, 464)
  Panel 2: (35, 391)  → (1118, 1232)
  Panel 3: (52, 1011) → (526, 1686)
  Panel 4: (530, 1118) → (1128, 1689)

Run from repo root:
  python harvester/test_page6.py
"""
import cv2
import numpy as np
from pathlib import Path

IMAGE = Path("public/comics/red-room/red-room-001-2021-digital-phillywilly-empire-1yyGum/page-006.jpg")

GROUND_TRUTH = [
    (100,  52, 1059,  464),
    ( 35, 391, 1118, 1232),
    ( 52,1011,  526, 1686),
    (530,1118, 1128, 1689),
]

# ── tunable knobs ────────────────────────────────────────────────────────────
DARK_THRESH    = 120   # gray ≤ this = dark background / gutter / border (higher catches mid-tone art)
MIN_BLOB_FRAC  = 0.04  # panel must be ≥ 4% of page
MAX_BLOB_FRAC  = 0.65  # panel must be ≤ 65% of page
CLOSE_PX       = 0     # no close — gutters between panels 3-6 are only 4px wide
PAD_FRAC       = 0.01  # padding added to each panel bbox
# Second-pass split: for blobs spanning > this fraction of page, try to split
SPLIT_WIDE     = 0.55  # blob width > 55% of page → try horizontal split
SPLIT_TALL     = 0.55  # blob height > 55% of page → try vertical split
# A split is accepted when the local minimum in the profile is below this
# fraction of the blob's median profile value (a relative dip).
SPLIT_MIN_RATIO = 0.60
# ─────────────────────────────────────────────────────────────────────────────

img  = cv2.imread(str(IMAGE))
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
H, W = gray.shape
page_area = H * W

print(f"Image: {W}x{H}")

# ── 1. Flood-fill dark background from outer margin ───────────────────────────
# The dark background (gutters + outer margin) is connected to the image border.
# Flood-fill from every border pixel that is "dark" to mark the entire background.
# Panel interiors (bright art) are enclosed by panel borders, so they stay unfilled.
dark_mask = (gray <= DARK_THRESH).astype(np.uint8)

# Seed flood from all four outer edges (1-pixel border)
flood = dark_mask.copy()
seeds = []
for x in range(W):
    if flood[0, x]:     seeds.append((0, x))
    if flood[H-1, x]:   seeds.append((H-1, x))
for y in range(H):
    if flood[y, 0]:     seeds.append((y, 0))
    if flood[y, W-1]:   seeds.append((y, W-1))

# BFS through connected dark pixels
visited = np.zeros((H, W), dtype=np.uint8)
from collections import deque
q = deque()
for (sy, sx) in seeds:
    if not visited[sy, sx]:
        visited[sy, sx] = 1
        q.append((sy, sx))

while q:
    y, x = q.popleft()
    for dy, dx in ((-1,0),(1,0),(0,-1),(0,1)):
        ny, nx = y+dy, x+dx
        if 0 <= ny < H and 0 <= nx < W and not visited[ny, nx] and dark_mask[ny, nx]:
            visited[ny, nx] = 1
            q.append((ny, nx))

# Panel interior pixels = NOT reached by the dark flood-fill AND NOT dark themselves
panel_interior = ((1 - visited) & (1 - dark_mask)).astype(np.uint8)
print(f"Panel interior pixels: {panel_interior.sum()}")

# ── 2. Morphological close to fill thin dark lines (art lines inside panels) ─
if CLOSE_PX > 0:
    kc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CLOSE_PX*2+1, CLOSE_PX*2+1))
    panel_interior = cv2.morphologyEx(panel_interior, cv2.MORPH_CLOSE, kc)

# ── 3. Find connected components = candidate panels ──────────────────────────
n_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(panel_interior)

blobs = []
all_areas = []
for i in range(1, n_labels):
    area = int(stats[i, cv2.CC_STAT_AREA])
    all_areas.append(area)
print(f"All blob areas (top 10): {sorted(all_areas, reverse=True)[:10]}")

for i in range(1, n_labels):
    area = int(stats[i, cv2.CC_STAT_AREA])
    frac = area / page_area
    if frac < MIN_BLOB_FRAC or frac > MAX_BLOB_FRAC:
        continue
    bx = int(stats[i, cv2.CC_STAT_LEFT])
    by = int(stats[i, cv2.CC_STAT_TOP])
    bw = int(stats[i, cv2.CC_STAT_WIDTH])
    bh = int(stats[i, cv2.CC_STAT_HEIGHT])
    blobs.append((bx, by, bx + bw, by + bh))

blobs.sort(key=lambda b: (b[1] + b[3]) // 2)
print(f"\nBlobs after size filter: {len(blobs)}")
for i, b in enumerate(blobs):
    print(f"  Blob {i+1}: ({b[0]},{b[1]}) → ({b[2]},{b[3]})  size={b[2]-b[0]}×{b[3]-b[1]}")

# ── 4. Second-pass: try to split large blobs using relative profile minima ────
bright_content = (gray > DARK_THRESH).astype(np.float32)  # inverted — bright = content

def find_relative_split(profile: np.ndarray, length: int, ratio: float):
    """Return split index if a clear relative minimum exists in middle 50% of profile."""
    mid_start = length // 4
    mid_end   = length * 3 // 4
    if mid_end <= mid_start:
        return None
    segment = profile[mid_start:mid_end]
    if segment.size == 0:
        return None
    med = float(np.median(profile))
    if med == 0:
        return None
    min_idx = int(np.argmin(segment))
    min_val = float(segment[min_idx])
    if min_val < med * ratio:
        return mid_start + min_idx
    return None

split_blobs = []
for (bx0, by0, bx1, by1) in blobs:
    bw, bh = bx1 - bx0, by1 - by0
    bright_region = bright_content[by0:by1, bx0:bx1]
    # Also build dark-pixel profile to find panel border lines
    dark_content  = (gray <= DARK_THRESH).astype(np.float32)
    dark_region   = dark_content[by0:by1, bx0:bx1]
    split_done = False

    # Try horizontal split for tall blobs: look for a row where dark pixels
    # are at a LOCAL PEAK (= panel border line crosses the full width).
    # This is more reliable than a bright-dip when art bleeds between panels.
    if bh > H * SPLIT_TALL:
        dark_row = dark_region.mean(axis=1)     # dark fraction per row
        bright_row = bright_region.mean(axis=1)
        mid_start = bh // 4
        mid_end   = bh * 3 // 4
        segment_d = dark_row[mid_start:mid_end]
        segment_b = bright_row[mid_start:mid_end]

        # Print diagnostic
        dark_max_idx = int(np.argmax(segment_d))
        bright_min_idx = int(np.argmin(segment_b))
        print(f"  Blob1 H-scan: dark_peak={segment_d[dark_max_idx]:.3f} at row={mid_start+dark_max_idx}"
              f"  bright_min={segment_b[bright_min_idx]:.3f} at row={mid_start+bright_min_idx}")
        print(f"  bright median={np.median(bright_row):.3f}  dark median={np.median(dark_row):.3f}")

        # Accept split at the dark-peak row (panel border) if dark fraction > median * 1.3
        if segment_d[dark_max_idx] > np.median(dark_row) * 1.3:
            split_y = mid_start + dark_max_idx
            print(f"  H-split (dark-peak) at y={by0+split_y}")
            split_blobs.append((bx0, by0,          bx1, by0 + split_y))
            split_blobs.append((bx0, by0 + split_y, bx1, by1))
            split_done = True
        elif segment_b[bright_min_idx] < np.median(bright_row) * SPLIT_MIN_RATIO:
            split_y = mid_start + bright_min_idx
            print(f"  H-split (bright-dip) at y={by0+split_y}")
            split_blobs.append((bx0, by0,          bx1, by0 + split_y))
            split_blobs.append((bx0, by0 + split_y, bx1, by1))
            split_done = True

    # Try vertical split (col profile) for wide blobs that didn't get H-split
    if not split_done and bw > W * SPLIT_WIDE:
        col_profile = bright_region.mean(axis=0)
        split_x = find_relative_split(col_profile, bw, SPLIT_MIN_RATIO)
        if split_x is not None:
            print(f"  V-split blob ({bx0},{by0})→({bx1},{by1}) at x={bx0+split_x}")
            split_blobs.append((bx0,           by0, bx0 + split_x, by1))
            split_blobs.append((bx0 + split_x, by0, bx1,           by1))
            split_done = True

    if not split_done:
        split_blobs.append((bx0, by0, bx1, by1))

blobs = split_blobs
print(f"\nBlobs after second-pass split: {len(blobs)}")
for i, b in enumerate(blobs):
    print(f"  Blob {i+1}: ({b[0]},{b[1]}) → ({b[2]},{b[3]})  size={b[2]-b[0]}×{b[3]-b[1]}")

# ── 4. Pad and clip ───────────────────────────────────────────────────────────
pad_px = int(min(H, W) * PAD_FRAC)
detected = []
for (px0,py0,px1,py1) in blobs:
    detected.append((
        max(0, px0 - pad_px), max(0, py0 - pad_px),
        min(W, px1 + pad_px), min(H, py1 + pad_px),
    ))

print(f"\nDetected panels ({len(detected)}):")
for i,(x0,y0,x1,y1) in enumerate(detected):
    print(f"  [{i+1}] ({x0},{y0}) → ({x1},{y1})  size={x1-x0}×{y1-y0}")

# ── 5. Compare against ground truth ──────────────────────────────────────────
def iou(a, b):
    ix0, iy0 = max(a[0],b[0]), max(a[1],b[1])
    ix1, iy1 = min(a[2],b[2]), min(a[3],b[3])
    if ix1<=ix0 or iy1<=iy0: return 0.0
    inter = (ix1-ix0)*(iy1-iy0)
    ua = (a[2]-a[0])*(a[3]-a[1])
    ub = (b[2]-b[0])*(b[3]-b[1])
    return inter/(ua+ub-inter)

print(f"\nGround truth ({len(GROUND_TRUTH)}) vs detected ({len(detected)}) — IoU matrix:")
print(f"{'':8}", end="")
for j in range(len(detected)):
    print(f"  Det{j+1:2}", end="")
print()
for i, gt in enumerate(GROUND_TRUTH):
    print(f"  GT {i+1}  ", end="")
    for j, det in enumerate(detected):
        print(f"  {iou(gt,det):.2f} ", end="")
    print()

# ── 6. Write debug image ─────────────────────────────────────────────────────
vis = img.copy()
# Show the panel interior mask in blue tint
interior_color = np.zeros_like(img)
interior_color[:,:,0] = panel_interior * 80  # blue channel
vis = cv2.addWeighted(vis, 1.0, interior_color, 0.4, 0)

for (x0,y0,x1,y1) in GROUND_TRUTH:
    cv2.rectangle(vis, (x0,y0),(x1,y1), (0,255,0), 4)   # green = ground truth
for (x0,y0,x1,y1) in detected:
    cv2.rectangle(vis, (x0,y0),(x1,y1), (0,120,255), 3)  # orange = detected

out_path = Path("harvester/debug_page6.jpg")
cv2.imwrite(str(out_path), vis)
print(f"\nDebug image written → {out_path}")
print("Green = ground truth, Orange = detected, Blue tint = panel interior mask")
