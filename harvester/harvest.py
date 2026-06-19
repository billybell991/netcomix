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
        import subprocess
        import shutil as _shutil
        import tempfile as _tempfile
        seven_z = (
            _shutil.which("7z") or _shutil.which("7zz")
            or (r"C:\Program Files\7-Zip\7z.exe" if sys.platform == "win32" else None)
        )
        if not seven_z:
            print(f"  ! Skipping {archive.name}: 7-Zip not found (install 7-Zip or use .cbz)", file=sys.stderr)
            return []
        with _tempfile.TemporaryDirectory() as _td:
            _extract_dir = Path(_td)
            subprocess.run(
                [seven_z, "e", str(archive), f"-o{_extract_dir}", "-y"],
                check=True, capture_output=True,
            )
            raw_pages = sorted(
                p for p in _extract_dir.iterdir()
                if p.suffix.lower() in IMAGE_EXTS
            )
            for i, src in enumerate(raw_pages, start=1):
                ext = src.suffix.lower()
                ext = ".jpg" if ext == ".jpeg" else ext
                out_path = dest_dir / f"page-{i:03d}{ext}"
                out_path.write_bytes(src.read_bytes())
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

    # ── Colored-border detection ──────────────────────────────────────────
    # Some comics (e.g. Papercutz TFTC) have a solid colored outer border
    # (purple, green, etc.) that fills both the page margins AND the gutters
    # between panels.  That makes every gutter row/col look "high ink" to the
    # standard content mask (gray < threshold), so projection-cut can't find
    # any gutters and returns a single splash-sized rect.
    #
    # Fix: sample the outer 5 % band.  If a non-white, non-black color
    # dominates (>25 % of the non-white pixels), treat pixels within ±30 gray
    # of that color as background (not ink) in the content mask.  Black ink and
    # colored artwork outside that narrow window are unaffected.
    _border_band = max(int(h * 0.05), 8)
    _border_px = np.concatenate([
        gray[:_border_band, :].ravel(),
        gray[-_border_band:, :].ravel(),
        gray[:, :_border_band].ravel(),
        gray[:, -_border_band:].ravel(),
    ])
    _colored_px = _border_px[(_border_px > 30) & (_border_px < 200)]
    _bg_gray: Optional[int] = None
    if _colored_px.size > 500:
        _hist, _bins = np.histogram(_colored_px, bins=50, range=(30, 200))
        _peak = int(np.argmax(_hist))
        _dominant = int((_bins[_peak] + _bins[_peak + 1]) / 2)
        if _hist[_peak] / _colored_px.size > 0.25:   # dominant color ≥25 % of colored border
            _bg_gray = _dominant

    def _make_content(threshold: int) -> np.ndarray:
        """Create an ink mask, optionally suppressing the detected border color."""
        base = (gray < threshold).astype(np.uint8)
        if _bg_gray is not None:
            base &= (np.abs(gray.astype(np.int16) - _bg_gray) > 30).astype(np.uint8)
        return base

    # content_mask: 1 where there's ink/art, 0 where the page is white (gutter).
    content = _make_content(gutter_threshold)

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
    content_225 = _make_content(225)

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
                # Loose-225 fallback (depth ≤ 1): dim-background pages where a
                # colored sky/background bleeds into the inter-row gutter.  The
                # gutter is still distinguishable as a clear LOCAL MINIMUM in
                # the 225-thresh row_ink profile (e.g. ~0.27 vs. surrounding
                # ~0.95 above), even though it never drops below ink_ratio.
                # Asymmetric sandwich: require a strong PEAK above the gutter
                # (panel border or content ending) with a sharp drop into the
                # gutter.  The "below" side may have any profile because the
                # next panel often starts with a white/sky background.
                if len(strips) < 2 and depth <= 1:
                    row_ink_225_loose = content_225[y0:y1, x0:x1].sum(axis=1) / rw
                    # Threshold raised from 0.30 → 0.40: the bbox-tightening
                    # (removing the page's white margin columns) raises the
                    # per-row ink fraction in true gutters by ~0.04-0.10.
                    # E.g. TFTC #02 p36 (black bleed-bottom panel) has gutter
                    # rows at ~0.28 full-width but ~0.32 cropped.  We compensate
                    # by raising the run threshold AND requiring the run to
                    # contain at least one VERY low row (< 0.30) — a real
                    # gutter has a clear low point, not a flat dim region.
                    runs_loose = find_gutter_runs(row_ink_225_loose, max(ink_ratio, 0.40), min_gutter_v)
                    band_l = max(min_gutter_v, 10)
                    loose_strips: List[Tuple[int, int]] = []
                    sandwich_cuts_loose: List[Tuple[int, int]] = []
                    for cs, ce in runs_loose:
                        # Min-deepness check: real gutter has a clear low point.
                        # A flat dim region (e.g. shaded sky inside a panel)
                        # would have min ≈ mean, which wouldn't dip below 0.30.
                        run_min = float(row_ink_225_loose[cs:ce].min())
                        if run_min >= 0.30:
                            continue
                        above_lo = max(0, cs - band_l * 2)
                        above_hi = max(0, cs - 2)
                        below_lo = min(rh, ce + 2)
                        below_hi = min(rh, ce + band_l * 2)
                        if above_hi - above_lo < band_l or below_hi - below_lo < band_l:
                            continue
                        above_peak = float(row_ink_225_loose[above_lo:above_hi].max())
                        below_peak = float(row_ink_225_loose[below_lo:below_hi].max())
                        gut_mean = float(row_ink_225_loose[cs:ce].mean())
                        # Need a strong peak (panel content / border row) on
                        # at least one side and a sharp drop into the gutter.
                        # Many comics lack a thick border line on the panel
                        # whose content side faces the gutter (e.g. a crowd
                        # panel that starts with white sky).  Require the
                        # OTHER (non-peak) side to contain at least some
                        # non-trivial content too (mean ≥ 0.20) so we don't
                        # split inside pure whitespace.
                        side_mean_above = float(row_ink_225_loose[:cs].mean()) if cs > 0 else 0.0
                        side_mean_below = float(row_ink_225_loose[ce:].mean()) if ce < rh else 0.0
                        strongest_peak = max(above_peak, below_peak)
                        if strongest_peak > 0.85 \
                                and (strongest_peak - gut_mean) >= 0.40 \
                                and side_mean_above > 0.20 and side_mean_below > 0.20:
                            sandwich_cuts_loose.append((cs, ce))
                    prev_loose = 0
                    for cs, ce in sandwich_cuts_loose:
                        if cs - prev_loose >= min_panel_h:
                            loose_strips.append((prev_loose, cs))
                        prev_loose = ce
                    if rh - prev_loose >= min_panel_h:
                        loose_strips.append((prev_loose, rh))
                    if len(loose_strips) > len(strips):
                        strips = loose_strips
                        _use_direct_leaf = True
                        for _s, _e in loose_strips:
                            needs_border_split.append((y0 + _s, y0 + _e))
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
                # Border-sandwich fallback (depth 0, h-axis): detect real panel
                # boundaries that have decorative speckling in the gutter.
                # Pattern: dark band (>=0.85 ink, >=min_gutter_v rows) → medium
                # gutter band (<0.50 ink, >=min_gutter_v rows) → dark band
                # (>=0.85 ink, >=min_gutter_v rows).  This sandwich is highly
                # specific to bordered panel layouts where the gutter contains
                # JPEG noise or border ornamentation that pushes its ink above
                # the standard thresholds.  TFTC v2 #01 page 11 has gutter ink
                # ~0.32–0.46 between thick black panel borders.
                if len(strips) < 2 and depth == 0:
                    band = max(min_gutter_v, 7)
                    candidate_runs = find_gutter_runs(row_ink, 0.50, min_gutter_v)
                    sandwich_cuts: List[Tuple[int, int]] = []
                    for cs, ce in candidate_runs:
                        above_lo = max(0, cs - band * 2)
                        above_hi = max(0, cs - 2)
                        below_lo = min(rh, ce + 2)
                        below_hi = min(rh, ce + band * 2)
                        if above_hi - above_lo < band or below_hi - below_lo < band:
                            continue
                        if (float(row_ink[above_lo:above_hi].mean()) > 0.85 and
                            float(row_ink[below_lo:below_hi].mean()) > 0.85):
                            sandwich_cuts.append((cs, ce))
                    sandwich_strips: List[Tuple[int, int]] = []
                    prev_s = 0
                    for cs, ce in sandwich_cuts:
                        if cs - prev_s >= min_panel_h:
                            sandwich_strips.append((prev_s, cs))
                        prev_s = ce
                    if rh - prev_s >= min_panel_h:
                        sandwich_strips.append((prev_s, rh))
                    if len(sandwich_strips) > len(strips):
                        strips = sandwich_strips
                # Oversized-gap guard: a real horizontal gutter is narrow (a few %
                # of page height).  If the vertical distance between two strips
                # is wider than a minimum panel, that "gutter" is EITHER:
                #   (a) a legitimate wide gutter region between rows where
                #       caption boxes / speech-bubble tails poke into the
                #       gutter space, leaving multiple distinct low-ink runs
                #       separated by thin sub-strips < min_panel_h, OR
                #   (b) a single panel mis-classified as background (e.g. dark
                #       mood lighting between rows where a long span has low
                #       ink across the whole panel).
                # Case (a) → 2+ distinct low-ink runs inside the gap → accept.
                # Case (b) → only 1 contiguous low-ink run in the gap → reject.
                if len(strips) >= 2:
                    bad_gap = False
                    for _i in range(len(strips) - 1):
                        _gs = strips[_i][1]
                        _ge = strips[_i + 1][0]
                        if _ge - _gs <= min_panel_h:
                            continue
                        _gap_runs = find_gutter_runs(row_ink[_gs:_ge], ink_ratio, min_gutter_v)
                        if len(_gap_runs) >= 2:
                            continue
                        bad_gap = True
                        break
                    if bad_gap:
                        strips = []
                # Border-continuity guard (depth ≥ 1 H-axis): mirror of the
                # V-axis guard.  A REAL panel H-gutter BREAKS the parent
                # strip's left+right panel-border lines at the gutter row.  A
                # FAKE H-gutter has the panel's left/right border running
                # CONTINUOUSLY across the gutter rows.
                if len(strips) >= 2 and depth >= 1:
                    scan = min(12, rw // 2)
                    left_col_ink = region[:, :scan].mean(axis=0)
                    right_col_ink = region[:, rw - scan:].mean(axis=0)
                    left_idx = int(np.argmax(left_col_ink))
                    right_idx = int(np.argmax(right_col_ink)) + (rw - scan)
                    band = 3
                    left_strip = region[:, max(0, left_idx - 1):left_idx + band]
                    right_strip = region[:, max(0, right_idx - band + 1):right_idx + 2]
                    left_avg = float(left_strip.mean())
                    right_avg = float(right_strip.mean())
                    if left_avg > 0.70 and right_avg > 0.70:
                        left_rows = left_strip.mean(axis=1)
                        right_rows = right_strip.mean(axis=1)
                        merged_h: List[Tuple[int, int]] = []
                        prev_s = strips[0][0]
                        prev_e = strips[0][1]
                        for i in range(len(strips) - 1):
                            gs = strips[i][1]
                            ge = strips[i + 1][0]
                            left_min = float(left_rows[gs:ge].min()) if ge > gs else 1.0
                            right_min = float(right_rows[gs:ge].min()) if ge > gs else 1.0
                            if left_min > 0.50 or right_min > 0.50:
                                # Border continuous across gutter → merge strips.
                                prev_e = strips[i + 1][1]
                            else:
                                merged_h.append((prev_s, prev_e))
                                prev_s = strips[i + 1][0]
                                prev_e = strips[i + 1][1]
                        merged_h.append((prev_s, prev_e))
                        if len(merged_h) < len(strips):
                            strips = merged_h
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
                # Oversized-gap guard: a real vertical gutter is narrow (a few %
                # of page width).  If the horizontal distance between two strips
                # is wider than a minimum panel, that "gutter" is EITHER:
                #   (a) a legitimate wide gutter region between columns where
                #       speech-bubble tails / captions poke into the gutter,
                #       leaving multiple distinct low-ink runs separated by
                #       thin sub-strips < min_panel_w, OR
                #   (b) a single panel mis-classified as background (e.g. dark
                #       space around a figure on a single wide panel).
                # Case (a) → 2+ distinct low-ink runs inside the gap → accept.
                # Case (b) → only 1 contiguous low-ink run in the gap → reject.
                if len(strips_v) >= 2:
                    bad_gap_v = False
                    for _i in range(len(strips_v) - 1):
                        _gs = strips_v[_i][1]
                        _ge = strips_v[_i + 1][0]
                        if _ge - _gs <= min_panel_w:
                            continue
                        _gap_runs_v = find_gutter_runs(col_ink[_gs:_ge], ink_ratio, min_gutter_h)
                        if len(_gap_runs_v) >= 2:
                            continue
                        bad_gap_v = True
                        break
                    if bad_gap_v:
                        strips_v = []
                # Border-continuity guard (depth ≥ 1 V-axis): a REAL panel
                # V-gutter at column g BREAKS the parent strip's top/bottom
                # panel-border lines at column g (because the border belongs to
                # the LEFT panel and ends just before g, then the RIGHT panel's
                # border starts just after g, leaving a low-ink gap at g).  A
                # FAKE V-gutter inside a single wide panel has the parent
                # panel's top+bottom border lines running CONTINUOUSLY across g
                # (high-ink at the very top and bottom rows at column g).
                # If the parent strip has high-ink edges (it's a bordered
                # panel) AND any gutter column has high-ink at BOTH the top
                # and bottom edge rows, reject — that gutter bisects a single
                # bordered panel (e.g. TFTC #1 p13 row 3: sky between woman
                # and man inside a single wide panel).
                if len(strips_v) >= 2 and depth >= 1:
                    # Find the strongest top and bottom border rows within the
                    # first/last 12 rows of the parent strip.  The depth-0 split
                    # can leave the strip starting/ending 1–2 rows inside the
                    # inter-row gutter, so a fixed edge_band of 3 rows can miss
                    # the actual panel border line.
                    scan = min(12, rh // 2)
                    top_row_ink = region[:scan, :].mean(axis=1)
                    bot_row_ink = region[rh - scan:, :].mean(axis=1)
                    top_idx = int(np.argmax(top_row_ink))
                    bot_idx = int(np.argmax(bot_row_ink)) + (rh - scan)
                    band = 3
                    top_strip = region[max(0, top_idx - 1):top_idx + band, :]
                    bot_strip = region[max(0, bot_idx - band + 1):bot_idx + 2, :]
                    top_avg = float(top_strip.mean())
                    bot_avg = float(bot_strip.mean())
                    # Only apply guard when the parent strip itself looks
                    # bordered (both top and bottom edges > 70% ink).
                    if top_avg > 0.70 and bot_avg > 0.70:
                        top_cols = top_strip.mean(axis=0)
                        bot_cols = bot_strip.mean(axis=0)
                        filtered: List[Tuple[int, int]] = []
                        for i in range(len(strips_v) - 1):
                            gs = strips_v[i][1]
                            ge = strips_v[i + 1][0]
                            # Check whether the border survives across this gutter.
                            # A REAL panel V-split interrupts BOTH borders.  If
                            # either border is continuous (> 0.50 ink at every
                            # gutter col), the gutter is bisecting a single
                            # bordered panel.
                            top_min = float(top_cols[gs:ge].min()) if ge > gs else 1.0
                            bot_min = float(bot_cols[gs:ge].min()) if ge > gs else 1.0
                            if top_min > 0.50 or bot_min > 0.50:
                                # Border continuous across gutter → fake gutter,
                                # merge the two adjacent strips by skipping this
                                # split point.
                                if filtered and filtered[-1][1] == strips_v[i][0]:
                                    filtered[-1] = (filtered[-1][0], strips_v[i + 1][1])
                                else:
                                    filtered.append((strips_v[i][0], strips_v[i + 1][1]))
                            else:
                                if filtered and filtered[-1][1] == strips_v[i][0]:
                                    pass
                                else:
                                    filtered.append(strips_v[i])
                                filtered.append(strips_v[i + 1])
                        # Deduplicate / merge
                        merged: List[Tuple[int, int]] = []
                        for s_, e_ in filtered:
                            if merged and merged[-1][1] >= s_:
                                merged[-1] = (merged[-1][0], max(merged[-1][1], e_))
                            else:
                                merged.append((s_, e_))
                        if len(merged) < len(strips_v):
                            strips_v = merged
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
    import os as _os
    if _os.environ.get("HARVEST_DEBUG"):
        print(f"  [DBG] tightened bbox: ({x0},{y0})-({x1},{y1})")
        print(f"  [DBG] split() rects ({len(rects)}): {rects[:8]}")

    # ── Colored-border fallback ────────────────────────────────────────────
    # If projection-cut returned just one big rect AND no border color was
    # found from the outer band, probe for uniformly-colored rows/cols.
    # Colored gutters (e.g. a solid purple strip between panels) have VERY LOW
    # row/column variance — all pixels are approximately the same mid-gray.
    # Content rows (artwork) are high-variance.  White-margin rows are high
    # mean (>200) so they're excluded from the sample.
    if len(rects) <= 1 and _bg_gray is None:
        _row_stds = gray.astype(np.float32).std(axis=1)
        _row_means = gray.mean(axis=1).astype(np.float32)
        _col_stds = gray.astype(np.float32).std(axis=0)
        _col_means = gray.mean(axis=0).astype(np.float32)
        _uniform_rows = (_row_stds < 20) & (_row_means > 60) & (_row_means < 200)
        _uniform_cols = (_col_stds < 20) & (_col_means > 60) & (_col_means < 200)
        _probe = np.concatenate([
            gray[_uniform_rows, :].ravel(),
            gray[:, _uniform_cols].ravel(),
        ])
        _probe = _probe[(_probe > 60) & (_probe < 200)]
        if _probe.size > 200:
            _hist_f, _bins_f = np.histogram(_probe, bins=30, range=(60, 200))
            _pk_f = int(np.argmax(_hist_f))
            if _hist_f[_pk_f] / _probe.size > 0.25:
                _bg_gray = int((_bins_f[_pk_f] + _bins_f[_pk_f + 1]) / 2)
                if _os.environ.get("HARVEST_DEBUG"):
                    print(f"  [DBG] colored-border fallback: bg_gray={_bg_gray}, "
                          f"probe_size={_probe.size}")
                content = _make_content(gutter_threshold)
                content_225 = _make_content(225)
                thin_gap_confirmed.clear()
                needs_border_split.clear()
                # Recompute tight bbox with border-stripped ink mask
                _ria2 = content.sum(axis=1) / w
                _cia2 = content.sum(axis=0) / h
                _riw2 = np.where(_ria2 >= bbox_ink_ratio)[0]
                _ciw2 = np.where(_cia2 >= bbox_ink_ratio)[0]
                if _riw2.size and _ciw2.size:
                    x0 = int(_ciw2[0])
                    y0 = int(_riw2[0])
                    x1 = int(_ciw2[-1] + 1)
                    y1 = int(_riw2[-1] + 1)
                rects = split(x0, y0, x1, y1, "h", 0)
                if _os.environ.get("HARVEST_DEBUG"):
                    print(f"  [DBG] fallback split() rects ({len(rects)}): {rects[:8]}")

    page_area = w * h

    # ── Pass 1: basic size + aspect-ratio filters ─────────────────────────
    panels: List[Panel] = []
    _splash_candidate: Optional[Tuple[int, int, int, int]] = None
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
        # But save it so we can attempt border-split detection later.
        if cw >= (x1 - x0) * 0.97 and ch >= (y1 - y0) * 0.97:
            _splash_candidate = (int(rx0), int(ry0), int(rx1), int(ry1))
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
    def _split_at_borders(px0: int, py0: int, px1: int, py1: int, only_white_gutter: bool = False, strict_adjacency: bool = False) -> List[Tuple[int, int, int, int]]:
        region = content[py0:py1, px0:px1].astype(np.float32)
        rh, rw = region.shape
        border_thr = 0.95  # column/row must be ≥95% dark to count as a border line

        def _interior_dividers(ink_1d: np.ndarray, length: int) -> List[Tuple[int, int]]:
            edge = max(int(length * 0.05), 8)
            min_run = max(3, int(length * 0.005))  # border must be ≥3px or 0.5% of dimension
            max_run = max(8, int(length * 0.012))   # real panel borders are thin (3-10px); false art runs are wider
            # Adjacent-ink guard (used only when strict_adjacency=True): a real
            # shared panel border separates two sub-panels of artwork whose
            # adjacent column avg ink is moderate (typically < 0.80) due to
            # speech bubbles + lighter colors.  A FAKE border found inside a
            # dark-background scene (a closet edge on TFTC #1 p8) has adjacent
            # columns that are ALSO dark (>0.85+) because the scene extends
            # through them.  Only applied in the panels_split loop where we're
            # FURTHER splitting an already-detected panel — the splash-
            # candidate path skips this guard so dark-background splashes can
            # still be split (e.g. TFTC #1 p23 caption splash).
            adj_band = max(8, int(length * 0.01))
            adj_dark_thr = 0.80
            divs: List[Tuple[int, int]] = []
            in_run, start = False, 0
            for i, v in enumerate(ink_1d):
                if v > border_thr:
                    if not in_run:
                        start = i
                        in_run = True
                else:
                    if in_run:
                        run_len = i - start
                        if min_run <= run_len <= max_run and start > edge and i < length - edge:
                            keep = True
                            if strict_adjacency:
                                lo_lo = max(0, start - adj_band)
                                lo_hi = start
                                hi_lo = i
                                hi_hi = min(length, i + adj_band)
                                left_avg = float(ink_1d[lo_lo:lo_hi].mean()) if lo_hi > lo_lo else 0.0
                                right_avg = float(ink_1d[hi_lo:hi_hi].mean()) if hi_hi > hi_lo else 0.0
                                if left_avg >= adj_dark_thr and right_avg >= adj_dark_thr:
                                    keep = False
                            if keep:
                                divs.append((start, i))
                        in_run = False
            if in_run:
                run_len = length - start
                if min_run <= run_len <= max_run and start > edge and run_len > edge:
                    divs.append((start, length))
            return divs

        col_ink = region.sum(axis=0) / max(rh, 1)

        # White-gutter mode: for 225-threshold direct leaves whose left/right
        # sub-panels are separated by a low-col-ink white gap (not a dark border).
        # Only look for columns with ink below ink_ratio (the same threshold used
        # by split() for column gutter detection).  Skip dark-border detection.
        if only_white_gutter:
            col_ink_225 = content_225[py0:py1, px0:px1].astype(np.float32).sum(axis=0) / max(rh, 1)
            col_edge = max(int(rw * 0.05), 8)
            white_runs = find_gutter_runs(col_ink_225, ink_ratio, min_gutter_h)
            white_interior = [(s, e) for (s, e) in white_runs
                              if s > col_edge and e < rw - col_edge]
            if white_interior:
                xs = [px0] + [px0 + (s + e) // 2 for s, e in white_interior] + [px1]
                return [(xs[i], py0, xs[i + 1], py1) for i in range(len(xs) - 1)]
            return [(px0, py0, px1, py1)]

        # Vertical split (panels side by side with shared vertical border)
        divs_v = _interior_dividers(col_ink, rw)
        if _os.environ.get("HARVEST_DEBUG") and divs_v:
            print(f"    [DBG] _split divs_v at ({px0},{py0})-({px1},{py1}): {divs_v}")
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

    # ── Pass 1.5 pre-check: if projection-cut found nothing (single full-page
    # rect was a splash candidate), try splitting it at shared borders before
    # giving up.  This handles pages where panels share thick black outlines
    # with no white gutter (so projection-cut can't find a split point).
    # Guard: only attempt if the top frame row has LOW ink (≥85% dark means
    # a solid colored bar like an ad header, not a comic panel border).
    # Comic pages with shared black panel borders typically have low-ink top margin.
    if _splash_candidate is not None:
        sc = _splash_candidate
        sub_rects = _split_at_borders(sc[0], sc[1], sc[2], sc[3])
        if len(sub_rects) > 1:
            found = []
            for (sx0, sy0, sx1, sy1) in sub_rects:
                cw, ch = sx1 - sx0, sy1 - sy0
                if cw >= min_panel_w and ch >= min_panel_h:
                    found.append(Panel(sx0, sy0, cw, ch, sx0 + cw // 2, sy0 + ch // 2))
            # Only commit if dropping undersized sub-rects doesn't leave a
            # panel-sized hole between adjacent survivors.  A gap >= min_panel_w
            # (column-split) or >= min_panel_h (row-split) means the dropped
            # slivers were where a real panel should have been (e.g. the central
            # yellow disk on TFTC #1 page 3 bottom row).  In that case the
            # "borders" were art content (figure outlines), not real panel
            # borders, so reject the split entirely.
            ok = len(found) >= 2
            if ok and len(found) < len(sub_rects):
                for i in range(len(found) - 1):
                    a, b = found[i], found[i + 1]
                    gx = b.x - (a.x + a.w)
                    gy = b.y - (a.y + a.h)
                    if gx > min_panel_w or gy > min_panel_h:
                        ok = False
                        break
            if ok:
                panels.extend(found)
        if _os.environ.get("HARVEST_DEBUG"):
            print(f"  [DBG] splash-border-split: {len(sub_rects)} rects → {len(panels)} panels")

    # ── Pass 1.6: Partial-height colored border fallback ──────────────────
    # Handles T-layout pages (2 top panels + 1 bottom) where a decorative
    # colored border strip separates the top panels but spans only the top
    # portion of the page height.  Global column statistics miss it because the
    # bottom panel has completely different pixels at those x positions.
    # Algorithm: scan each interior column for the longest sustained run of
    # mid-gray pixels (80–210 gray, std < 20).  Group consecutive columns
    # with overlapping runs.  Guards:
    #   (a) the strip must divide the page 25–75% horizontally
    #   (b) the strip must start within the top 35% of content height
    #   (c) the strip must span < 50% of total content height (prevents
    #       uniform-colored full-height art regions from triggering)
    if _splash_candidate is not None and len(panels) == 0:
        _pb_ch = y1 - y0
        _pb_cw = x1 - x0
        _pb_min_run = max(100, int(_pb_ch * 0.15))
        _pb_std_thr = 20.0
        _pb_x_margin = max(int(_pb_cw * 0.10), 20)
        _pb_col_data: dict = {}
        for _pb_x in range(x0 + _pb_x_margin, x1 - _pb_x_margin):
            _pb_col = gray[y0:y1, _pb_x].astype(np.float32)
            _pb_mid = (_pb_col > 80) & (_pb_col < 210)
            _pb_runs: list = []
            _pb_cs, _pb_cl = 0, 0
            for _pb_i, _pb_v in enumerate(_pb_mid):
                if _pb_v:
                    if _pb_cl == 0:
                        _pb_cs = _pb_i
                    _pb_cl += 1
                else:
                    if _pb_cl > 0:
                        _pb_runs.append([_pb_cs, _pb_cs + _pb_cl])
                    _pb_cl = 0
            if _pb_cl > 0:
                _pb_runs.append([_pb_cs, _pb_cs + _pb_cl])
            # Merge runs separated by ≤5 px gaps
            _pb_merged: list = []
            for _pb_r in _pb_runs:
                if _pb_merged and _pb_r[0] - _pb_merged[-1][1] <= 5:
                    _pb_merged[-1][1] = _pb_r[1]
                else:
                    _pb_merged.append(_pb_r[:])
            _pb_bl, _pb_bs = 0, 0
            for _pb_r in _pb_merged:
                _l = _pb_r[1] - _pb_r[0]
                if _l > _pb_bl:
                    _pb_bl = _l
                    _pb_bs = _pb_r[0]
            if _pb_bl >= _pb_min_run:
                _pb_seg = _pb_col[_pb_bs:_pb_bs + _pb_bl]
                if float(_pb_seg.std()) < _pb_std_thr:
                    _pb_col_data[_pb_x] = (_pb_bs, _pb_bs + _pb_bl)
        if _pb_col_data:
            _pb_sorted = sorted(_pb_col_data.keys())
            _pb_groups: list = []
            _pb_cg = [_pb_sorted[0]]
            for _pb_x in _pb_sorted[1:]:
                _pb_px = _pb_cg[-1]
                if _pb_x - _pb_px <= 3:
                    _pb_pr = _pb_col_data[_pb_px]
                    _pb_cr = _pb_col_data[_pb_x]
                    if _pb_cr[0] < _pb_pr[1] and _pb_cr[1] > _pb_pr[0]:
                        _pb_cg.append(_pb_x)
                        continue
                _pb_groups.append(_pb_cg)
                _pb_cg = [_pb_x]
            _pb_groups.append(_pb_cg)
            _pb_mgw = max(8, int(_pb_cw * 0.005))
            _pb_valid: list = []
            for _pb_g in _pb_groups:
                if len(_pb_g) < _pb_mgw:
                    continue
                _pb_ys = [_pb_col_data[_pb_x][0] for _pb_x in _pb_g]
                _pb_ye = [_pb_col_data[_pb_x][1] for _pb_x in _pb_g]
                _pb_bx = x0 + (_pb_g[0] - x0 + _pb_g[-1] - x0) // 2
                _pb_by0 = int(np.median(_pb_ys))
                _pb_by1 = int(np.median(_pb_ye))
                _pb_span = _pb_by1 - _pb_by0
                _pb_lf = (_pb_bx - x0) / _pb_cw
                if not (0.25 <= _pb_lf <= 0.75):
                    continue
                # Strip must start near the top of the content area (within 8%).
                # A T-layout border strip begins at the very top of the top panels;
                # if it starts midway down the page, it's art content, not a gutter.
                if _pb_by0 > _pb_ch * 0.08:
                    continue
                if y0 + _pb_by0 > y0 + _pb_ch * 0.35:
                    continue
                if _pb_span > _pb_ch * 0.50:
                    continue
                _pb_valid.append((_pb_bx, y0 + _pb_by0, y0 + _pb_by1, _pb_span))
            _pb_valid.sort(key=lambda v: -v[3])
            for (_pb_bx, _pb_aby0, _pb_aby1, _pb_span) in _pb_valid:
                _pb_ty1 = _pb_aby1
                _pb_bh = y1 - _pb_ty1
                _pb_th = _pb_ty1 - y0
                _pb_lw = _pb_bx - x0
                _pb_rw = x1 - _pb_bx
                if _pb_lw < min_panel_w or _pb_rw < min_panel_w or _pb_th < min_panel_h:
                    continue
                panels.append(Panel(x0, y0, _pb_lw, _pb_th, x0 + _pb_lw // 2, y0 + _pb_th // 2))
                panels.append(Panel(_pb_bx, y0, _pb_rw, _pb_th, _pb_bx + _pb_rw // 2, y0 + _pb_th // 2))
                if _pb_bh >= min_panel_h:
                    panels.append(Panel(x0, _pb_ty1, x1 - x0, _pb_bh, x0 + (x1 - x0) // 2, _pb_ty1 + _pb_bh // 2))
                if _os.environ.get("HARVEST_DEBUG"):
                    print(f"  [DBG] partial-border fallback: bx={_pb_bx}, top_y1={_pb_ty1}, "
                          f"span={_pb_span}, {len(panels)} panels")
                break

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
                added_panels = []
                for (sx0, sy0, sx1, sy1) in sub_rects:
                    cw, ch = sx1 - sx0, sy1 - sy0
                    if cw >= min_panel_w and ch >= min_panel_h:
                        added_panels.append(Panel(sx0, sy0, cw, ch, sx0 + cw // 2, sy0 + ch // 2))
                # Same "no panel-sized hole" rule as the splash-candidate path.
                ok = len(added_panels) >= 2
                if ok and len(added_panels) < len(sub_rects):
                    for i in range(len(added_panels) - 1):
                        a, b = added_panels[i], added_panels[i + 1]
                        gx = b.x - (a.x + a.w)
                        gy = b.y - (a.y + a.h)
                        if gx > min_panel_w or gy > min_panel_h:
                            ok = False
                            break
                if ok:
                    panels_split.extend(added_panels)
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
                sub_rects = _split_at_borders(p.x, p.y, p.x + p.w, p.y + p.h, strict_adjacency=True)
                if len(sub_rects) > 1:
                    added_panels = []
                    for (sx0, sy0, sx1, sy1) in sub_rects:
                        cw, ch = sx1 - sx0, sy1 - sy0
                        if cw >= min_panel_w and ch >= min_panel_h:
                            added_panels.append(Panel(sx0, sy0, cw, ch, sx0 + cw // 2, sy0 + ch // 2))
                    # Same "no panel-sized hole" rule as the splash-candidate path.
                    ok = len(added_panels) >= 2
                    if ok and len(added_panels) < len(sub_rects):
                        for i in range(len(added_panels) - 1):
                            a, b = added_panels[i], added_panels[i + 1]
                            gx = b.x - (a.x + a.w)
                            gy = b.y - (a.y + a.h)
                            if gx > min_panel_w or gy > min_panel_h:
                                ok = False
                                break
                    if ok:
                        panels_split.extend(added_panels)
                        continue  # replaced by valid sub-panels
        panels_split.append(p)
    panels = panels_split
    if _os.environ.get("HARVEST_DEBUG"):
        print(f"  [DBG] after Pass 1.5: {len(panels)} panels")

    # Pass 1.7: remove panels substantially contained in a larger sibling
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
    if _os.environ.get("HARVEST_DEBUG"):
        print(f"  [DBG] entering Pass 2: {len(panels)} panels")
    if len(panels) > 12:
        panels = []

    if len(panels) >= 2:
        areas = np.array([p.w * p.h for p in panels], dtype=float)

        # Uniformity (coefficient of variation): real comic pages have varied
        # panel sizes for dramatic pacing; catalog grids are suspiciously
        # regular.  CV = σ/μ — low CV means all panels are the same size.
        cv = float(areas.std() / areas.mean()) if areas.mean() > 0 else 0.0
        uniform_threshold = 0.15
        # Mean panel area as fraction of page — the size discriminator between
        # a comic grid (few large panels, mean ≥10% of page) and a catalog /
        # gallery (many small thumbnails, mean ≪10%).  Without this guard the
        # uniformity / grid rules wipe legitimate uniform comic layouts.
        mean_area_frac = float(areas.mean()) / page_area if page_area > 0 else 0.0
        # Only apply uniformity check for 6+ panels: fewer panels may legitimately
        # have similar sizes (e.g. a 2×2 or 2×3 comic layout).  Also require the
        # panels to be small (mean < 8% of page) — large uniform panels are
        # comic, not catalog.
        if len(panels) >= 6 and cv < uniform_threshold and mean_area_frac < 0.08:
            if _os.environ.get("HARVEST_DEBUG"):
                print(f"  [DBG] uniform filter wiped panels: cv={cv:.3f}, mean_area_frac={mean_area_frac:.3f}")
            panels = []  # looks like a thumbnail grid / catalog page

        # Geometric grid check: if panel centres snap to a rows×cols grid AND
        # panels are uniform in size, it's almost certainly a gallery layout.
        # Require all of: geometric alignment, low CV, AND small mean area —
        # the size guard preserves valid 2×2 / 2×3 comic page layouts (where
        # each panel is ≥10% of the page) while still wiping dense catalogs.
        if panels and len(panels) >= 4:
            tol = 0.12
            bin_x = lambda p: round(p.centerX / (w * tol))
            bin_y = lambda p: round(p.centerY / (h * tol))
            n_cols = len(set(bin_x(p) for p in panels))
            n_rows = len(set(bin_y(p) for p in panels))
            if (n_rows >= 2 and n_cols >= 2
                    and n_rows * n_cols == len(panels)
                    and cv < 0.25
                    and mean_area_frac < 0.08):
                if _os.environ.get("HARVEST_DEBUG"):
                    print(f"  [DBG] grid filter wiped panels: {n_rows}×{n_cols}, cv={cv:.3f}, mean_area_frac={mean_area_frac:.3f}")
                panels = []  # regular uniform grid of small tiles → catalog

        # Total coverage: if surviving panels cover less than 35 % of the page,
        # there's too much non-panel content (text blocks, blank space) — treat
        # as a splash.
        if panels:
            total_coverage = float(areas.sum()) / page_area
            if _os.environ.get("HARVEST_DEBUG"):
                print(f"  [DBG] coverage={total_coverage:.3f}, CV={cv:.3f}, len={len(panels)}")
            if total_coverage < 0.35:
                panels = []
        if _os.environ.get("HARVEST_DEBUG"):
            print(f"  [DBG] after Pass 2: {len(panels)} panels")
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

    # Dominant color (mean of a downsampled copy — cheap and good enough for
    # the reader's letterbox background tint).
    small = cv2.resize(img, (50, 75))
    mean = small.reshape(-1, 3).mean(axis=0)
    b, g, r = int(mean[0]), int(mean[1]), int(mean[2])
    dominant = f"#{r:02x}{g:02x}{b:02x}"

    return w, h, panels, dominant


# ---------------------------------------------------------------------------
# Balloon / caption fallback detector
# ---------------------------------------------------------------------------

def detect_balloons_and_captions(image_path: Path) -> List[Panel]:
    """Fallback for non-cover pages where projection-cut returns no panels.

    Finds speech balloons, thought bubbles, and narrative caption boxes by
    locating enclosed light regions that cannot be reached by flood-filling
    from the page border — i.e. regions enclosed by dark ink borders.

    Two threshold passes:
      200 — white speech balloons and white caption boxes
      230 — additionally catches yellow/tinted narrative caption boxes (~210-230 gray)

    Exclusion rules applied to every candidate:
      - Area < 0.4 % of page → noise
      - Area > 40 % of page  → art content, not a balloon
      - Bottom 9 % of page   → barcodes, page numbers, publisher info
      - Top 4 % AND width > 35 % of page → chapter headers, logos
      - Interior mean brightness < 130 → dark art region, not a balloon
      - Aspect ratio outside [0.15, 8.0] → degenerate sliver or bar

    Hard cap: if > 12 candidates remain, return [] (probably detecting art
    regions on a panel-dense page — better to show the full page).

    Not called on dark-background pages (outer-border darkness > 55 %).
    Returns panels sorted in reading order (top → bottom, left → right).
    """
    if not HAS_CV:
        return []
    img = cv2.imread(str(image_path))
    if img is None:
        return []
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    page_area = w * h

    # Skip dark-background pages — the dark-bg flood-fill in detect_panels already
    # tried those, and if it returned [] there simply are no detectable regions.
    # Also skip pages with dark or colored outer borders (e.g., purple border around
    # panels, dark-green Polaroid collage pages).  On those pages the flood-fill seeds
    # can't spread across the border, so ALL interior light regions appear "enclosed" —
    # this produces false positives from art backgrounds and character highlights.
    # Guard: skip if outer-border mean brightness < 165 (captures dark, purple, green,
    # blue borders while allowing white and yellow page backgrounds through).
    _band = max(int(h * 0.04), 6)
    _outer = np.concatenate([
        gray[:_band, :].ravel(), gray[-_band:, :].ravel(),
        gray[:, :_band].ravel(), gray[:, -_band:].ravel(),
    ])
    if float(_outer.mean()) < 165:
        return []

    y_header_cut = int(h * 0.04)    # top 4 % — logos, chapter headers
    y_barcode_cut = int(h * 0.91)   # bottom 9 % — barcodes, page numbers
    min_area = page_area * 0.004    # 0.4 % — smaller = noise
    max_area = page_area * 0.05     # 5 % — larger = art region, not a balloon
    # Speech balloons never span more than half the page width.
    # Wider regions are photo frames, art backgrounds, or panel borders.
    max_balloon_w = int(w * 0.50)

    candidates: List[Panel] = []
    seen_keys: set = set()  # deduplicate bounding-box origins across passes

    for thresh in (200, 230):
        _, binary = cv2.threshold(gray, thresh, 255, cv2.THRESH_BINARY)
        bg = binary.copy()

        # Flood-fill from a dense grid of border pixels to paint the page background
        # as 128.  After all seeds run, any pixel still at 255 is enclosed by ink.
        step_x = max(1, w // 20)
        step_y = max(1, h // 20)
        for sx in range(0, w, step_x):
            for edge_y in (0, h - 1):
                if bg[edge_y, sx] == 255:
                    cv2.floodFill(bg, np.zeros((h + 2, w + 2), dtype=np.uint8),
                                  (sx, edge_y), 128)
        for sy in range(0, h, step_y):
            for edge_x in (0, w - 1):
                if bg[sy, edge_x] == 255:
                    cv2.floodFill(bg, np.zeros((h + 2, w + 2), dtype=np.uint8),
                                  (edge_x, sy), 128)

        enclosed = (bg == 255).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(enclosed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for cnt in cnts:
            area = cv2.contourArea(cnt)
            if area < min_area or area > max_area:
                continue
            bx, by, bw, bh = cv2.boundingRect(cnt)
            # Also filter by bounding box area: sparse/ring-shaped regions (e.g. photo
            # frames) have small contour area but large bounding boxes.  The reader snaps
            # to the bounding box, so filter by bbox footprint too.
            if bw * bh > page_area * 0.07:
                continue
            # Deduplicate: treat bounding-box origins within 20 px as the same region
            key = (bx // 20, by // 20)
            if key in seen_keys:
                continue
            # Exclude wide header regions near the top
            if by < y_header_cut and bw > w * 0.35:
                continue
            # Exclude regions wider than half the page (photo frames, art backgrounds)
            if bw > max_balloon_w:
                continue
            # Exclude barcode / footer zone
            if (by + bh) > y_barcode_cut:
                continue
            # Exclude if region centre is in the footer
            if (by + bh // 2) > int(h * 0.93):
                continue
            if bh == 0:
                continue
            aspect = bw / bh
            if not (0.15 <= aspect <= 8.0):
                continue
            # Balloon / caption interior must be light (not a dark art region)
            if float(gray[by:by + bh, bx:bx + bw].mean()) < 130:
                continue
            # Fill ratio check: real speech balloons and caption boxes fill most of
            # their bounding box with bright enclosed pixels.  Art highlights, spiky
            # hair, and other sparse enclosed shapes have a large bbox but few bright
            # pixels — they'd produce wrong snap targets.  Require at least 40 % fill.
            enclosed_fill = int((enclosed[by:by + bh, bx:bx + bw] == 255).sum())
            if enclosed_fill / (bw * bh) < 0.40:
                continue
            seen_keys.add(key)
            candidates.append(Panel(
                x=bx, y=by, w=bw, h=bh,
                centerX=bx + bw // 2, centerY=by + bh // 2,
            ))

    if not candidates or len(candidates) > 12:
        return []

    # Reading order: bucket rows, then left-to-right within each row
    bucket = max(int(h * 0.08), 20)
    candidates.sort(key=lambda p: (p.y // bucket, p.x))
    return candidates


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
    for page_idx, p in enumerate(pages):
        w, h, panels, dom = detect_panels(p, gutter_threshold=gutter_threshold)
        # Non-cover page with no panels → try balloon / caption fallback
        if page_idx > 0 and not panels:
            panels = detect_balloons_and_captions(p)
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
