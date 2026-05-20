import cv2, numpy as np
import sys
sys.path.insert(0, 'harvester')

# Monkey-patch detect_panels to add tracing
from pathlib import Path
import harvest as hv

_orig_split = None

def trace_page(pg):
    imgpath = rf'public\comics\issue01\issue01\page-0{pg:02d}.jpg'
    img = cv2.imread(imgpath)
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    content = (gray < 230).astype(np.uint8)
    row_ink = content.sum(axis=1) / w
    min_gutter_v = max(int(h * 0.004), 5)
    ink_ratio = 0.20
    print(f"\n=== Page {pg} ({w}x{h}) min_gutter_v={min_gutter_v} ===")

    # find_gutter_runs manually
    def find_gutter_runs(profile, threshold, min_run):
        empty = profile < threshold
        runs = []
        i = 0
        n = len(empty)
        while i < n:
            if empty[i]:
                j = i
                while j < n and empty[j]:
                    j += 1
                if j - i >= min_run:
                    runs.append((i, j))
                i = j
            else:
                i += 1
        return runs

    runs = find_gutter_runs(row_ink, ink_ratio, min_gutter_v)
    print(f"  Gutter runs ({len(runs)}): {runs}")

    min_panel_h = int(h * 0.10)
    strips = []
    prev = 0
    for s, e in runs:
        if s - prev >= min_panel_h:
            strips.append((prev, s))
        prev = e
    if h - prev >= min_panel_h:
        strips.append((prev, h))
    print(f"  Content strips ({len(strips)}): {strips}")
    print(f"  --> Would produce panels: {len(strips) >= 2}")

trace_page(22)
trace_page(11)
trace_page(20)

