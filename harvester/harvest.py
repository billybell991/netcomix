"""
NetComix Harvester — converts .cbz / .cbr files into the JSON manifests
the reader app consumes.

Output layout (matches src/types.ts):
  <output>/library.json                              -> { series: [...] }
  <output>/<series>/series.json                      -> { issues: [...] }
  <output>/<series>/<issue>/issue.json               -> { pages: [{file, w, h, panels[], dominantColor}, ...] }
  <output>/<series>/<issue>/page-XXX.jpg             -> extracted page images
  <output>/<series>/<issue>/cover.jpg                -> first page (also referenced as cover)

Run:
  python -m harvester.harvest --source ./comics-source --output ./public/comics

Or directly:
  python harvester/harvest.py --source ./comics-source --output ./public/comics
"""

from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    HAS_CV = True
except ImportError:  # pragma: no cover — harvester degrades gracefully without OpenCV
    HAS_CV = False

try:
    from PIL import Image  # type: ignore
    HAS_PIL = True
except ImportError:  # pragma: no cover
    HAS_PIL = False


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
ARCHIVE_EXTS = {".cbz", ".zip"}
RAR_EXTS = {".cbr", ".rar"}


@dataclass
class Panel:
    x: int
    y: int
    w: int
    h: int
    centerX: int
    centerY: int


@dataclass
class PageManifest:
    file: str
    width: int
    height: int
    panels: List[Panel]
    dominantColor: Optional[str] = None


# ---------------------------------------------------------------------------
# Slug + parsing helpers
# ---------------------------------------------------------------------------

def slugify(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    return name or "untitled"


def parse_title(filename: str) -> Tuple[str, str]:
    """Return (series_title, issue_title) parsed from a filename like
    'Star Wars - Han Solo - Imperial Cadet 001 (2019) (...).cbz'."""
    stem = Path(filename).stem
    # Strip trailing parenthetical tags
    stem = re.sub(r"\s*\([^)]*\)\s*", " ", stem).strip()
    # Look for "...NNN" issue number at the end
    m = re.search(r"^(.*?)[\s\-_]+(\d{1,4})\s*$", stem)
    if m:
        series = m.group(1).strip(" -_")
        issue_num = m.group(2)
        return series, f"{series} #{int(issue_num):03d}"
    # Fallback: whole stem is the "issue", series = first chunk before " - "
    if " - " in stem:
        series = stem.split(" - ", 1)[0].strip()
        return series, stem
    return stem, stem


# ---------------------------------------------------------------------------
# Archive extraction
# ---------------------------------------------------------------------------

def _list_zip_images(path: Path) -> List[str]:
    with zipfile.ZipFile(path) as z:
        return sorted(
            [n for n in z.namelist() if Path(n).suffix.lower() in IMAGE_EXTS and not n.startswith("__MACOSX/")]
        )


def _extract_zip_image(zf: zipfile.ZipFile, name: str) -> bytes:
    with zf.open(name) as f:
        return f.read()


def extract_pages(archive: Path, dest_dir: Path) -> List[Path]:
    """Extract all images from a .cbz/.zip (or .cbr/.rar via fallback) into dest_dir
    renamed page-001.jpg, page-002.jpg, ... Returns ordered list of paths."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = archive.suffix.lower()
    out: List[Path] = []

    if suffix in ARCHIVE_EXTS:
        with zipfile.ZipFile(archive) as zf:
            names = sorted(
                [n for n in zf.namelist() if Path(n).suffix.lower() in IMAGE_EXTS and not n.startswith("__MACOSX/")]
            )
            for i, name in enumerate(names, start=1):
                data = _extract_zip_image(zf, name)
                ext = Path(name).suffix.lower()
                ext = ".jpg" if ext == ".jpeg" else ext
                out_path = dest_dir / f"page-{i:03d}{ext}"
                out_path.write_bytes(data)
                out.append(out_path)
        return out

    if suffix in RAR_EXTS:
        try:
            import rarfile  # type: ignore
        except ImportError:
            print(f"  ! Skipping {archive.name}: install 'rarfile' + unrar to support .cbr", file=sys.stderr)
            return []
        with rarfile.RarFile(archive) as rf:
            names = sorted([n for n in rf.namelist() if Path(n).suffix.lower() in IMAGE_EXTS])
            for i, name in enumerate(names, start=1):
                with rf.open(name) as f:
                    data = f.read()
                ext = Path(name).suffix.lower()
                ext = ".jpg" if ext == ".jpeg" else ext
                out_path = dest_dir / f"page-{i:03d}{ext}"
                out_path.write_bytes(data)
                out.append(out_path)
        return out

    print(f"  ! Unsupported archive: {archive}", file=sys.stderr)
    return []


# ---------------------------------------------------------------------------
# Panel detection
# ---------------------------------------------------------------------------

def detect_panels(image_path: Path, gutter_threshold: int = 230) -> Tuple[int, int, List[Panel], Optional[str]]:
    """Return (width, height, panels, dominantColor).

    Uses a recursive projection-cut algorithm: a comic page is split by finding
    horizontal then vertical gutters (bands of mostly-white pixels). This is
    robust to mixed layouts — e.g. a row of two panels above a single wide
    panel — which contour-based approaches struggle with because the two top
    panels merge across thin gutters when morphologically closed.

    If OpenCV is unavailable, returns no panels (full-page-only).
    """
    if not HAS_CV:
        if HAS_PIL:
            with Image.open(image_path) as im:
                return im.width, im.height, [], None
        return 0, 0, [], None

    img = cv2.imread(str(image_path))
    if img is None:
        return 0, 0, [], None
    h, w = img.shape[:2]

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # content_mask: 1 where there's ink/art, 0 where the page is white (gutter).
    content = (gray < gutter_threshold).astype(np.uint8)

    # Knobs (relative to page size so they scale with resolution):
    #   min_gutter:    how many consecutive near-empty rows/cols count as a gutter
    #   min_panel_w/h: smallest plausible panel
    #   ink_ratio:     a row/col counts as "gutter" if fewer than this fraction
    #                  of its pixels are ink. Needs to be loose enough to
    #                  forgive the panel-border lines that bracket the gutter
    #                  (a 2–3 px black line on a 1200 px wide row is ~0.2% ink
    #                  per line, but anti-aliasing + speech-bubble tails push
    #                  real gutters into the 3–8% range).
    #   bbox_ink_ratio: tighter threshold for trimming the outer page margins
    #                  so we don't lop legitimate panel-border ink off the bbox.
    min_gutter_v = max(int(h * 0.004), 5)   # horizontal gutter (between rows)
    min_gutter_h = max(int(w * 0.004), 5)   # vertical gutter (between cols)
    min_panel_w = int(w * 0.18)
    min_panel_h = int(h * 0.10)
    # 0.20 (was 0.10) — dark-background comics have gutters with up to ~15%
    # residual dark pixels from anti-aliasing, speech-bubble tails, and thin
    # panel border lines; 0.20 catches those without creating false gutters in
    # typical content rows (which run 25-70% dark).
    ink_ratio = 0.20
    bbox_ink_ratio = 0.02

    # Tighter content mask (< 225) used by the yellow-caption gutter fallback.
    # Yellow narration caption boxes (~218-228 gray) are counted as ink by the
    # main content mask (< 230) and can block detection of inter-row gutters.
    # content_225 treats those caption pixels as white, exposing the real gutter.
    content_225 = (gray < 225).astype(np.uint8)

    # Strips produced by the thin-gap fallback are confirmed single-panel rows;
    # they must NOT be further split by _split_at_borders (the fallback has
    # already identified them as correctly bounded panels).
    thin_gap_confirmed: List[Tuple[int, int]] = []  # (y0_abs, y1_abs)
    # 225-threshold direct leaf strips: need _split_at_borders with white-gutter
    # detection only (their left/right gutter is a low-col-ink white gap, not a
    # high-col-ink dark border like dark-background pages).
    needs_border_split: List[Tuple[int, int]] = []  # (y0_abs, y1_abs)

    def find_gutter_runs(profile: np.ndarray, threshold: float, min_run: int) -> List[Tuple[int, int]]:
        """Return list of (start, end_exclusive) index ranges where profile < threshold
        for at least `min_run` consecutive samples."""
        empty = profile < threshold
        runs: List[Tuple[int, int]] = []
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

    def split(x0: int, y0: int, x1: int, y1: int, axis: str, depth: int) -> List[Tuple[int, int, int, int]]:
        """Recursively split a region. axis is the *preferred* axis to try first
        ('h' = look for horizontal gutters to make rows; 'v' = vertical gutters
        to make columns). Returns a list of leaf rectangles."""
        if depth > 8:  # safety bound — comics rarely nest more than a few levels
            return [(x0, y0, x1, y1)]
        region = content[y0:y1, x0:x1]
        rh, rw = region.shape
        if rh < min_panel_h or rw < min_panel_w:
            return [(x0, y0, x1, y1)]

        # Try the preferred axis first; if that yields nothing, try the other.
        for try_axis in (axis, "v" if axis == "h" else "h"):
            if try_axis == "h":
                # Horizontal gutters → bands of empty rows → row split
                row_ink = region.sum(axis=1) / rw  # fraction of ink per row
                runs = find_gutter_runs(row_ink, ink_ratio, min_gutter_v)
                # Convert gutter runs into row strips (skip strips that are too short)
                strips: List[Tuple[int, int]] = []
                prev = 0
                for s, e in runs:
                    if s - prev >= min_panel_h:
                        strips.append((prev, s))
                    prev = e
                if rh - prev >= min_panel_h:
                    strips.append((prev, rh))
                # Shallow fallback: subtle-border pages (e.g. dark backgrounds) have
                # interior gutters at higher ink fractions; try a more permissive
                # threshold when the initial scan didn't produce a useful split.
                # Applies at depth 0-1 (initial page/sub-strip splits) and depth 2
                # (sub-column splits) to handle 2×2 grids where the inner horizontal
                # gutter inside each column is bordered and reads as high-ink.
                if len(strips) < 2 and depth <= 2:
                    runs2 = find_gutter_runs(row_ink, max(ink_ratio, 0.30), min_gutter_v)
                    strips2: List[Tuple[int, int]] = []
                    prev2 = 0
                    for s, e in runs2:
                        if s - prev2 >= min_panel_h:
                            strips2.append((prev2, s))
                        prev2 = e
                    if rh - prev2 >= min_panel_h:
                        strips2.append((prev2, rh))
                    if len(strips2) > len(strips):
                        strips = strips2
                # Yellow-caption fallback (depth ≤ 1): recompute row_ink with the
                # tighter 225 threshold.  Yellow narration boxes (~218-228 gray) that
                # sit at the border between two rows block gutter detection when the
                # standard mask (< 230) counts them as ink. content_225 treats those
                # caption pixels as white, revealing the true inter-row gap.
                # Strips from this fallback are returned as direct leaf rects (no
                # recursive vertical re-split) so that Pass 1.5 (_split_at_borders)
                # handles any left/right sub-panel detection in one controlled pass.
                _use_direct_leaf = False
                if len(strips) < 2 and depth <= 1:
                    row_ink_225 = content_225[y0:y1, x0:x1].sum(axis=1) / rw
                    runs3 = find_gutter_runs(row_ink_225, ink_ratio, min_gutter_v)
                    strips3: List[Tuple[int, int]] = []
                    prev3 = 0
                    for s, e in runs3:
                        if s - prev3 >= min_panel_h:
                            strips3.append((prev3, s))
                        prev3 = e
                    if rh - prev3 >= min_panel_h:
                        strips3.append((prev3, rh))
                    if len(strips3) > len(strips):
                        strips = strips3
                        _use_direct_leaf = True
                        for _s3, _e3 in strips3:
                            needs_border_split.append((y0 + _s3, y0 + _e3))
                # Thin-gap fallback (depth ≤ 1): detect single-row white gaps
                # between high-ink regions.  Some comics (e.g. Papercutz TFTC)
                # reduce the whitespace between rows to just 1 pure-white pixel
                # because narration caption boxes extend to the panel edge.
                # Strips from this fallback are BOTH returned as direct leaf rects
                # AND registered in thin_gap_confirmed so Pass 1.5 skips them.
                if len(strips) < 2 and depth <= 1:
                    for i in range(min_gutter_v, rh - min_gutter_v):
                        if row_ink[i] < 0.03:
                            left_avg = float(row_ink[max(0, i - min_gutter_v * 2):max(0, i - 2)].mean())
                            right_avg = float(row_ink[min(rh, i + 2):min(rh, i + min_gutter_v * 2)].mean())
                            if left_avg > 0.50 and right_avg > 0.50:
                                gs = max(0, i - min_gutter_v // 2)
                                ge = min(rh, i + min_gutter_v // 2 + 1)
                                gap_strips: List[Tuple[int, int]] = []
                                prevg = 0
                                if gs - prevg >= min_panel_h:
                                    gap_strips.append((prevg, gs))
                                prevg = ge
                                if rh - prevg >= min_panel_h:
                                    gap_strips.append((prevg, rh))
                                if len(gap_strips) >= 2:
                                    strips = gap_strips
                                    _use_direct_leaf = True
                                    for _s, _e in gap_strips:
                                        thin_gap_confirmed.append((y0 + _s, y0 + _e))
                                break
                if len(strips) >= 2:
                    out: List[Tuple[int, int, int, int]] = []
                    for s, e in strips:
                        # Tighten this strip's horizontal extent to where its ink lives
                        sub = region[s:e, :]
                        col_ink = sub.sum(axis=0) / max(sub.shape[0], 1)
                        nonempty = np.where(col_ink >= bbox_ink_ratio)[0]
                        if nonempty.size == 0:
                            continue
                        cx0 = int(nonempty[0])
                        cx1 = int(nonempty[-1] + 1)
                        if _use_direct_leaf:
                            # Return as leaf without further recursive splitting.
                            # For thin-gap strips: they are single-scene panels.
                            # For 225-threshold strips: Pass 1.5 (_split_at_borders)
                            # handles any left/right sub-panel structure in one pass.
                            out.append((x0 + cx0, y0 + s, x0 + cx1, y0 + e))
                        else:
                            out.extend(split(x0 + cx0, y0 + s, x0 + cx1, y0 + e, "v", depth + 1))
                    if out:
                        return out
            else:
                # Vertical gutters → bands of empty cols → column split
                col_ink = region.sum(axis=0) / rh
                runs = find_gutter_runs(col_ink, ink_ratio, min_gutter_h)
                strips_v: List[Tuple[int, int]] = []
                prev = 0
                for s, e in runs:
                    if s - prev >= min_panel_w:
                        strips_v.append((prev, s))
                    prev = e
                if rw - prev >= min_panel_w:
                    strips_v.append((prev, rw))
                # Shallow fallback (vertical axis): only at depth 0 — applying it
                # at depth 1 risks false vertical splits within panel artwork.
                if len(strips_v) < 2 and depth == 0:
                    runs2_v = find_gutter_runs(col_ink, max(ink_ratio, 0.30), min_gutter_h)
                    strips2_v: List[Tuple[int, int]] = []
                    prev2_v = 0
                    for s, e in runs2_v:
                        if s - prev2_v >= min_panel_w:
                            strips2_v.append((prev2_v, s))
                        prev2_v = e
                    if rw - prev2_v >= min_panel_w:
                        strips2_v.append((prev2_v, rw))
                    if len(strips2_v) > len(strips_v):
                        strips_v = strips2_v
                if len(strips_v) >= 2:
                    out = []
                    for s, e in strips_v:
                        sub = region[:, s:e]
                        row_ink = sub.sum(axis=1) / max(sub.shape[1], 1)
                        nonempty = np.where(row_ink >= bbox_ink_ratio)[0]
                        if nonempty.size == 0:
                            continue
                        cy0 = int(nonempty[0])
                        cy1 = int(nonempty[-1] + 1)
                        out.extend(split(x0 + s, y0 + cy0, x0 + e, y0 + cy1, "h", depth + 1))
                    if out:
                        return out

        # No split possible on either axis — this region is a leaf panel.
        return [(x0, y0, x1, y1)]

    # Tighten the initial bounding box to the page's inked region (drops the
    # outer white margin so the first split doesn't mistake margin for gutter).
    row_ink_all = content.sum(axis=1) / w
    col_ink_all = content.sum(axis=0) / h
    rows_with_ink = np.where(row_ink_all >= bbox_ink_ratio)[0]
    cols_with_ink = np.where(col_ink_all >= bbox_ink_ratio)[0]
    if rows_with_ink.size and cols_with_ink.size:
        y0 = int(rows_with_ink[0])
        y1 = int(rows_with_ink[-1] + 1)
        x0 = int(cols_with_ink[0])
        x1 = int(cols_with_ink[-1] + 1)
    else:
        x0, y0, x1, y1 = 0, 0, w, h

    rects = split(x0, y0, x1, y1, "h", 0)

    page_area = w * h

    # ── Pass 1: basic size + aspect-ratio filters ─────────────────────────
    panels: List[Panel] = []
    for (rx0, ry0, rx1, ry1) in rects:
        cw = rx1 - rx0
        ch = ry1 - ry0
        # Must meet minimum dimension thresholds.
        if cw < min_panel_w or ch < min_panel_h:
            continue
        # Must be at least 8 % of total page area (kills thumbnail-sized boxes).
        if (cw * ch) / page_area < 0.08:
            continue
        # Sane aspect ratio: 0.15 ≤ w/h ≤ 6.0  (drops degenerate slivers).
        aspect = cw / ch if ch > 0 else 0
        if not (0.15 <= aspect <= 6.0):
            continue
        # Drop a single rect that covers the whole inked area — the page is a
        # splash and the reader should show the full page instead.
        if cw >= (x1 - x0) * 0.97 and ch >= (y1 - y0) * 0.97:
            continue
        panels.append(
            Panel(
                x=int(rx0), y=int(ry0), w=int(cw), h=int(ch),
                centerX=int(rx0 + cw // 2), centerY=int(ry0 + ch // 2),
            )
        )

    # ── Pass 1.5: split bordered panels that share a border line ──────────
    # Projection-cut can't detect gutters inside thick black borders because the
    # shared border column has 95–100% ink (high, not low).  Instead we look for
    # interior columns/rows with *very* high ink (>95%) that span the full
    # height/width of the detected panel — those are the shared border lines.
    # Guard: only try if the top and bottom rows of the panel are themselves
    # high-ink (≥80%), confirming the panel has a rectangular border frame.
    def _split_at_borders(px0: int, py0: int, px1: int, py1: int, only_white_gutter: bool = False) -> List[Tuple[int, int, int, int]]:
        region = content[py0:py1, px0:px1].astype(np.float32)
        rh, rw = region.shape
        border_thr = 0.95  # column/row must be ≥95% dark to count as a border line

        def _interior_dividers(ink_1d: np.ndarray, length: int) -> List[Tuple[int, int]]:
            edge = max(int(length * 0.05), 8)
            divs: List[Tuple[int, int]] = []
            in_run, start = False, 0
            for i, v in enumerate(ink_1d):
                if v > border_thr:
                    if not in_run:
                        start = i
                        in_run = True
                else:
                    if in_run:
                        if start > edge and i < length - edge:
                            divs.append((start, i))
                        in_run = False
            if in_run and start > edge and length - start > edge:
                divs.append((start, length))
            return divs

        col_ink = region.sum(axis=0) / max(rh, 1)

        # White-gutter mode: for 225-threshold direct leaves whose left/right
        # sub-panels are separated by a low-col-ink white gap (not a dark border).
        # Only look for columns with ink below ink_ratio (the same threshold used
        # by split() for column gutter detection).  Skip dark-border detection.
        if only_white_gutter:
            col_edge = max(int(rw * 0.05), 8)
            white_runs = find_gutter_runs(col_ink, ink_ratio, min_gutter_h)
            white_interior = [(s, e) for (s, e) in white_runs
                              if s > col_edge and e < rw - col_edge]
            if white_interior:
                xs = [px0] + [px0 + (s + e) // 2 for s, e in white_interior] + [px1]
                return [(xs[i], py0, xs[i + 1], py1) for i in range(len(xs) - 1)]
            return [(px0, py0, px1, py1)]

        # Vertical split (panels side by side with shared vertical border)
        divs_v = _interior_dividers(col_ink, rw)
        if divs_v:
            xs = [px0] + [px0 + (s + e) // 2 for s, e in divs_v] + [px1]
            return [(xs[i], py0, xs[i + 1], py1) for i in range(len(xs) - 1)]

        # Horizontal split (panels stacked with shared horizontal border)
        row_ink = region.sum(axis=1) / max(rw, 1)
        divs_h = _interior_dividers(row_ink, rh)
        if divs_h:
            ys = [py0] + [py0 + (s + e) // 2 for s, e in divs_h] + [py1]
            return [(px0, ys[i], px1, ys[i + 1]) for i in range(len(ys) - 1)]

        return [(px0, py0, px1, py1)]

    panels_split: List[Panel] = []
    for p in panels:
        # Thin-gap confirmed strips are already correctly identified as single-scene
        # horizontal panels — skip _split_at_borders to prevent false vertical splits.
        if any(abs(p.y - _sy0) < 5 and abs(p.y + p.h - _sy1) < 5
               for (_sy0, _sy1) in thin_gap_confirmed):
            panels_split.append(p)
            continue
        # 225-threshold direct leaves: their sub-panel gutter is white (low col-ink),
        # not a dark border.  Use white-gutter-only mode regardless of top_ink.
        if any(abs(p.y - _sy0) < 5 and abs(p.y + p.h - _sy1) < 5
               for (_sy0, _sy1) in needs_border_split):
            sub_rects = _split_at_borders(p.x, p.y, p.x + p.w, p.y + p.h, only_white_gutter=True)
            if len(sub_rects) > 1:
                added = 0
                for (sx0, sy0, sx1, sy1) in sub_rects:
                    cw, ch = sx1 - sx0, sy1 - sy0
                    if cw >= min_panel_w and ch >= min_panel_h:
                        panels_split.append(Panel(sx0, sy0, cw, ch, sx0 + cw // 2, sy0 + ch // 2))
                        added += 1
                if added > 0:
                    continue
            panels_split.append(p)
            continue
        # Only attempt if the panel is wide enough to plausibly contain 2+ side-by-side
        # bordered panels, AND has thick border rows at top and bottom (≥80% ink).
        is_wide = p.w > w * 0.40
        is_tall = p.h > h * 0.40
        if is_wide or is_tall:
            top_ink = float(content[p.y:p.y + 15, p.x:p.x + p.w].mean())
            if top_ink > 0.85:
                sub_rects = _split_at_borders(p.x, p.y, p.x + p.w, p.y + p.h)
                if len(sub_rects) > 1:
                    added = 0
                    for (sx0, sy0, sx1, sy1) in sub_rects:
                        cw, ch = sx1 - sx0, sy1 - sy0
                        if cw >= min_panel_w and ch >= min_panel_h:
                            panels_split.append(Panel(sx0, sy0, cw, ch, sx0 + cw // 2, sy0 + ch // 2))
                            added += 1
                    if added > 0:
                        continue  # replaced by valid sub-panels
        panels_split.append(p)
    panels = panels_split

    # ── Pass 1.7: remove panels substantially contained in a larger sibling ──
    # Projection-cut is recursive and should not produce overlapping rects, but
    # bbox-tightening on sub-strips can create a smaller rect whose ink footprint
    # nearly coincides with the interior of a larger detected panel (e.g. a title
    # banner whose tight horizontal bbox sits inside a big splash panel below it).
    # Remove any panel where ≥80% of its area is covered by a larger sibling.
    if len(panels) >= 2:
        def _isect(a: Panel, b: Panel) -> int:
            ix0 = max(a.x, b.x); ix1 = min(a.x + a.w, b.x + b.w)
            iy0 = max(a.y, b.y); iy1 = min(a.y + a.h, b.y + b.h)
            return max(0, ix1 - ix0) * max(0, iy1 - iy0)
        keep = [True] * len(panels)
        for i, pi in enumerate(panels):
            ai = pi.w * pi.h
            for j, pj in enumerate(panels):
                if i == j or not keep[j]:
                    continue
                if pj.w * pj.h <= ai:
                    continue  # only a larger sibling can contain pi
                if _isect(pi, pj) / ai >= 0.80:
                    keep[i] = False
                    break
        panels = [p for k, p in zip(keep, panels) if k]

    # ── Pass 1.8: complementary left-panel detection ──────────────────────
    # In dark-background comics, _split_at_borders may fragment a left panel
    # into many tiny slivers (all < min_panel_w) when the right panel area
    # has uniformly high col_ink (thick dark border + dark art).  The result
    # is that only the right sub-panel survives for that row.  Detect this
    # case and synthesize the missing left panel from the uncovered region.
    #
    # Trigger: a row bucket has panels that all start at x > 35% of page
    # width (right-biased), meaning the left side of the row is uncovered.
    if panels:
        _bucket_p18 = max(int(h * 0.08), 20)
        row_groups_p18: dict = {}
        for p in panels:
            b = p.y // _bucket_p18
            row_groups_p18.setdefault(b, []).append(p)
        extra: List[Panel] = []
        page_w_ink = x1 - x0
        for _b, grp in row_groups_p18.items():
            leftmost_x = min(p.x for p in grp)
            # Right-biased: all panels start past 35% of the inked page width
            if leftmost_x <= x0 + page_w_ink * 0.35:
                continue
            row_y0 = min(p.y for p in grp)
            row_y1 = max(p.y + p.h for p in grp)
            row_h = row_y1 - row_y0
            compl_x0, compl_x1 = x0, leftmost_x
            compl_w = compl_x1 - compl_x0
            if compl_w < min_panel_w or row_h < min_panel_h:
                continue
            # Guard 1: the complement must cover a substantial fraction of the page
            # width (≥ 45%).  Sub-panels of a falsely split row often produce a
            # right-biased remainder that is narrower than 45% of the page.
            if compl_w < page_w_ink * 0.45:
                continue
            # Guard 2: the complement region must NOT be substantially covered by
            # an existing panel (e.g. a tall left-column panel that spans this y range).
            # If ≥ 50% of the complement area already belongs to a sibling panel,
            # skip — we'd be adding a duplicate (or the false sub-panel is inside
            # an already-detected real panel).
            compl_area = compl_w * row_h
            already_covered = False
            for other in panels:
                if other.x == leftmost_x and other.y == row_y0:
                    continue  # same panel
                ox0, oy0 = other.x, other.y
                ox1, oy1 = other.x + other.w, other.y + other.h
                ix0 = max(compl_x0, ox0); ix1 = min(compl_x1, ox1)
                iy0 = max(row_y0, oy0);   iy1 = min(row_y1, oy1)
                isect = max(0, ix1 - ix0) * max(0, iy1 - iy0)
                if isect / compl_area >= 0.50:
                    already_covered = True
                    break
            if already_covered:
                continue
            # Guard 3: the complementary region must contain real panel content
            # (not just blank margin) — at least 10% dark ink pixels.
            sg = gray[row_y0:row_y1, compl_x0:compl_x1]
            if float((sg < 80).mean()) < 0.10:
                continue
            extra.append(Panel(compl_x0, row_y0, compl_w, row_h,
                               compl_x0 + compl_w // 2, row_y0 + row_h // 2))
        if extra:
            panels.extend(extra)
            panels.sort(key=lambda p: (p.y // _bucket_p18, p.x))

    # ── Pass 2: catalog / gallery / splash heuristics ────────────────────
    # Western comics: 3-6 panels is typical, 12 is a practical ceiling
    # (dense pages can have 8-10 panels; 9 was too aggressive).
    if len(panels) > 12:
        panels = []

    if len(panels) >= 2:
        areas = np.array([p.w * p.h for p in panels], dtype=float)

        # Uniformity (coefficient of variation): real comic pages have varied
        # panel sizes for dramatic pacing; catalog grids are suspiciously
        # regular.  CV = σ/μ — low CV means all panels are the same size.
        cv = float(areas.std() / areas.mean()) if areas.mean() > 0 else 0.0
        uniform_threshold = 0.15
        # Only apply uniformity check for 4+ panels: 2-3 same-width horizontal
        # row strips always have similar areas (same width dominates) and are
        # valid comic layouts, not catalog grids.
        if len(panels) >= 4 and cv < uniform_threshold:
            panels = []  # looks like a thumbnail grid / catalog page

        # Geometric grid check: if panel centres snap to a rows×cols grid,
        # it's almost certainly a gallery layout, not a comic layout.
        if panels and len(panels) >= 4:
            tol = 0.12
            bin_x = lambda p: round(p.centerX / (w * tol))
            bin_y = lambda p: round(p.centerY / (h * tol))
            n_cols = len(set(bin_x(p) for p in panels))
            n_rows = len(set(bin_y(p) for p in panels))
            if n_rows >= 2 and n_cols >= 2 and n_rows * n_cols == len(panels):
                panels = []  # regular grid → not comic panels

        # Total coverage: if surviving panels cover less than 35 % of the page,
        # there's too much non-panel content (text blocks, blank space) — treat
        # as a splash.
        if panels:
            total_coverage = float(areas.sum()) / page_area
            if total_coverage < 0.35:
                panels = []

    # ── Dark-background fallback ─────────────────────────────────────────────
    # When projection-cut yields 0 panels on a page with a dark background
    # (diagonal gutters, bleed art, non-white separators), detect panel interiors
    # by flood-filling the connected dark background from the outer margin and
    # treating the isolated bright islands as panels.
    # Guard: only runs when panels is still empty AND the outer border is dark.
    if not panels:
        _dark_thr = 120 # below this = dark background / border / gutter / mid-tone art
        # Sample the outer frame (4% inset band) to check background brightness
        _band = max(int(h * 0.04), 6)
        _outer = np.concatenate([
            gray[:_band, :].ravel(), gray[-_band:, :].ravel(),
            gray[:, :_band].ravel(), gray[:, -_band:].ravel(),
        ])
        _dark_frac = float((_outer <= _dark_thr).mean())
        if _dark_frac > 0.55:
            # Build dark mask and find the connected background via connected components:
            # Pad with a 1-pixel dark border so all four outer edges are in one component.
            _dm = (gray <= _dark_thr).astype(np.uint8)
            _padded = np.pad(_dm, 1, mode='constant', constant_values=1)
            _, _cc = cv2.connectedComponents(_padded, connectivity=4)
            _bg_label = int(_cc[0, 0])
            _bg_mask = (_cc[1:-1, 1:-1] == _bg_label).astype(np.uint8)
            # Panel interior = not background AND not dark
            _interior = ((1 - _bg_mask) & (1 - _dm)).astype(np.uint8)
            # (no morphological close: would bridge thin gutters between adjacent panels)
            # Find candidate panel blobs
            _nl, _, _sts, _ = cv2.connectedComponentsWithStats(_interior)
            _blobs: List[Tuple[int, int, int, int]] = []
            for _i in range(1, _nl):
                _a = int(_sts[_i, cv2.CC_STAT_AREA])
                if 0.04 <= _a / page_area <= 0.65:
                    _bx = int(_sts[_i, cv2.CC_STAT_LEFT])
                    _by = int(_sts[_i, cv2.CC_STAT_TOP])
                    _bw2 = int(_sts[_i, cv2.CC_STAT_WIDTH])
                    _bh2 = int(_sts[_i, cv2.CC_STAT_HEIGHT])
                    _blobs.append((_bx, _by, _bx + _bw2, _by + _bh2))
            _blobs.sort(key=lambda b: (b[1] + b[3]) // 2)
            # Second-pass: split large merged blobs using dark-peak (border line)
            # or bright-dip (column gap) profiles.
            _dark_pf  = (_dm).astype(np.float32)
            _bright_pf = (1 - _dm).astype(np.float32)
            _split: List[Tuple[int, int, int, int]] = []
            for (_bx0, _by0, _bx1, _by1) in _blobs:
                _bh2, _bw2 = _by1 - _by0, _bx1 - _bx0
                _done = False
                # Horizontal split for tall blobs (panels stacked / diagonal gutter)
                if _bh2 > h * 0.55:
                    _dr = _dark_pf[_by0:_by1, _bx0:_bx1].mean(axis=1)
                    _br = _bright_pf[_by0:_by1, _bx0:_bx1].mean(axis=1)
                    _ms, _me = _bh2 // 4, _bh2 * 3 // 4
                    _sd, _sb = _dr[_ms:_me], _br[_ms:_me]
                    _med_d, _med_b = float(np.median(_dr)), float(np.median(_br))
                    _pd = int(np.argmax(_sd))
                    _pb = int(np.argmin(_sb))
                    if _sd[_pd] > _med_d * 1.3:
                        _sy = _ms + _pd
                        _split += [(_bx0, _by0, _bx1, _by0 + _sy),
                                   (_bx0, _by0 + _sy, _bx1, _by1)]
                        _done = True
                    elif _med_b > 0 and _sb[_pb] < _med_b * 0.60:
                        _sy = _ms + _pb
                        _split += [(_bx0, _by0, _bx1, _by0 + _sy),
                                   (_bx0, _by0 + _sy, _bx1, _by1)]
                        _done = True
                # Vertical split for wide blobs (side-by-side panels)
                if not _done and _bw2 > w * 0.55:
                    _bc = _bright_pf[_by0:_by1, _bx0:_bx1].mean(axis=0)
                    _ms, _me = _bw2 // 4, _bw2 * 3 // 4
                    _sc = _bc[_ms:_me]
                    _med_c = float(np.median(_bc))
                    if _med_c > 0:
                        _px = int(np.argmin(_sc))
                        if _sc[_px] < _med_c * 0.60:
                            _sx = _ms + _px
                            _split += [(_bx0, _by0, _bx0 + _sx, _by1),
                                       (_bx0 + _sx, _by0, _bx1,  _by1)]
                            _done = True
                if not _done:
                    _split.append((_bx0, _by0, _bx1, _by1))
            # Convert split results to Panel objects
            _pad_ff = max(int(min(w, h) * 0.01), 5)
            for (_rx0, _ry0, _rx1, _ry1) in _split:
                _cw, _ch = _rx1 - _rx0, _ry1 - _ry0
                if _cw < min_panel_w or _ch < min_panel_h:
                    continue
                if (_cw * _ch) / page_area < 0.05:
                    continue
                _px0c = max(0, _rx0 - _pad_ff)
                _py0c = max(0, _ry0 - _pad_ff)
                _px1c = min(w, _rx1 + _pad_ff)
                _py1c = min(h, _ry1 + _pad_ff)
                _cw2, _ch2 = _px1c - _px0c, _py1c - _py0c
                panels.append(Panel(_px0c, _py0c, _cw2, _ch2,
                                    _px0c + _cw2 // 2, _py0c + _ch2 // 2))

    # Sort into reading order (top-to-bottom, left-to-right).
    bucket = max(int(h * 0.08), 20)
    panels.sort(key=lambda p: (p.y // bucket, p.x))

    # ── Post-process: discard a lone dark-bg fallback panel that is too small
    # to be the only panel on the page.  When the dark-bg blob flood-fill
    # produces exactly 1 panel covering < 15% of the page, showing the full
    # page is better than zooming into that 1 tiny panel.
    if len(panels) == 1 and (panels[0].w * panels[0].h) / page_area < 0.15:
        panels = []

    # ── Post-process: insert row-overview panels before each multi-panel row ─
    # For horizontal rows containing 2+ sub-panels, prepend a "row overview"
    # panel covering the entire row's bounding box.  This gives readers context
    # (the full strip) before zooming into each individual panel — the same
    # reading rhythm used in most comic reader apps.
    if len(panels) >= 2:
        row_groups: List[List[Panel]] = []
        cur_group: List[Panel] = [panels[0]]
        for p in panels[1:]:
            if p.y // bucket == cur_group[0].y // bucket:
                cur_group.append(p)
            else:
                row_groups.append(cur_group)
                cur_group = [p]
        row_groups.append(cur_group)

        panels_with_overviews: List[Panel] = []
        for grp in row_groups:
            if len(grp) >= 2:
                rx0 = min(p.x for p in grp)
                ry0 = min(p.y for p in grp)
                rx1 = max(p.x + p.w for p in grp)
                ry1 = max(p.y + p.h for p in grp)
                rov_w, rov_h = rx1 - rx0, ry1 - ry0
                max_sub_w = max(p.w for p in grp)
                # Only add the overview when the combined row is meaningfully
                # wider than any single sub-panel (confirms it's a real
                # multi-panel row, not a duplicate detection), and it doesn't
                # swallow almost the whole page (which would be a splash).
                if rov_w > max_sub_w * 1.1 and (rov_w * rov_h) / page_area < 0.80:
                    panels_with_overviews.append(
                        Panel(rx0, ry0, rov_w, rov_h,
                              rx0 + rov_w // 2, ry0 + rov_h // 2)
                    )
            panels_with_overviews.extend(grp)
        panels = panels_with_overviews

    # Dominant color (mean of a downsampled copy — cheap and good enough for
    # the reader's letterbox background tint).
    small = cv2.resize(img, (50, 75))
    mean = small.reshape(-1, 3).mean(axis=0)
    b, g, r = int(mean[0]), int(mean[1]), int(mean[2])
    dominant = f"#{r:02x}{g:02x}{b:02x}"

    return w, h, panels, dominant


# ---------------------------------------------------------------------------
# Main harvest pipeline
# ---------------------------------------------------------------------------

def harvest_issue(archive: Path, series_dir: Path, issue_slug: str, issue_title: str,
                   gutter_threshold: int) -> Optional[dict]:
    issue_dir = series_dir / issue_slug
    if issue_dir.exists():
        shutil.rmtree(issue_dir)
    issue_dir.mkdir(parents=True, exist_ok=True)

    pages = extract_pages(archive, issue_dir)
    if not pages:
        print(f"  ! Skipping {archive.name}: no pages extracted (corrupt or empty archive?)", file=sys.stderr)
        shutil.rmtree(issue_dir, ignore_errors=True)
        return None

    page_manifests: List[PageManifest] = []
    for p in pages:
        w, h, panels, dom = detect_panels(p, gutter_threshold=gutter_threshold)
        page_manifests.append(PageManifest(
            file=p.name, width=w, height=h, panels=panels, dominantColor=dom
        ))

    cover_name = pages[0].name
    manifest = {
        "id": issue_slug,
        "title": issue_title,
        "series": series_dir.name,
        "cover": cover_name,
        "pages": [
            {
                "file": pm.file,
                "width": pm.width,
                "height": pm.height,
                "panels": [asdict(p) for p in pm.panels],
                "dominantColor": pm.dominantColor,
            }
            for pm in page_manifests
        ],
    }
    (issue_dir / "issue.json").write_text(json.dumps(manifest, indent=2))
    return {
        "id": issue_slug,
        "title": issue_title,
        "cover": cover_name,
        "pageCount": len(pages),
        "path": f"{series_dir.name}/{issue_slug}",
    }


def harvest_all(source: Path, output: Path, gutter_threshold: int = 230) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    archives = sorted([
        p for p in source.rglob("*")
        if p.is_file() and p.suffix.lower() in (ARCHIVE_EXTS | RAR_EXTS)
    ])
    print(f"Found {len(archives)} archive(s) in {source}")

    # Group by series
    by_series: dict[str, List[Tuple[Path, str, str]]] = {}
    for arc in archives:
        series_title, issue_title = parse_title(arc.name)
        series_slug = slugify(series_title)
        issue_slug = slugify(Path(arc.name).stem)
        by_series.setdefault(series_slug, []).append((arc, issue_slug, issue_title))
        # Remember series title for the slug
        by_series_titles[series_slug] = series_title

    series_index = []
    for series_slug, entries in by_series.items():
        series_dir = output / series_slug
        series_dir.mkdir(parents=True, exist_ok=True)
        series_title = by_series_titles.get(series_slug, series_slug)
        print(f"\n[{series_title}] {len(entries)} issue(s)")

        issue_entries = []
        for arc, issue_slug, issue_title in entries:
            print(f"  - {arc.name}")
            entry = harvest_issue(arc, series_dir, issue_slug, issue_title, gutter_threshold)
            if entry:
                issue_entries.append(entry)

        if not issue_entries:
            shutil.rmtree(series_dir, ignore_errors=True)
            continue

        # Series index
        series_doc = {"id": series_slug, "title": series_title, "issues": issue_entries}
        (series_dir / "series.json").write_text(json.dumps(series_doc, indent=2))

        first = issue_entries[0]
        series_index.append({
            "id": series_slug,
            "title": series_title,
            "cover": f"{first['id']}/{first['cover']}",
            "issueCount": len(issue_entries),
            "path": series_slug,
        })

    library = {
        "generatedAt": _dt.datetime.utcnow().isoformat() + "Z",
        "series": series_index,
    }
    (output / "library.json").write_text(json.dumps(library, indent=2))
    print(f"\nWrote {output / 'library.json'} with {len(series_index)} series.")
    return library


by_series_titles: dict[str, str] = {}


def main(argv: Optional[Iterable[str]] = None) -> int:
    p = argparse.ArgumentParser(description="NetComix harvester")
    p.add_argument("--source", required=True, type=Path, help="Directory of .cbz/.cbr files")
    p.add_argument("--output", required=True, type=Path, help="Output directory (e.g. public/comics)")
    p.add_argument("--gutter", type=int, default=230, help="Brightness threshold for gutters (0-255)")
    args = p.parse_args(list(argv) if argv is not None else None)

    if not args.source.exists():
        print(f"Source does not exist: {args.source}", file=sys.stderr)
        return 2

    harvest_all(args.source, args.output, gutter_threshold=args.gutter)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
