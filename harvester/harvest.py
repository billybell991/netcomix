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
    """Return (width, height, panels, dominantColor). Panels are sorted into
    reading order (top-to-bottom, left-to-right). If OpenCV is unavailable,
    returns no panels (full-page-only)."""
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
    # Threshold: white gutters → black, content → white (inverted)
    _, thresh = cv2.threshold(gray, gutter_threshold, 255, cv2.THRESH_BINARY_INV)
    # Morphological close to merge speech bubbles into their parent panels
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_w = int(w * 0.12)
    min_h = int(h * 0.08)
    max_area = w * h * 0.95  # reject "the whole page is one panel" noise
    panels: List[Panel] = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if cw < min_w or ch < min_h:
            continue
        if cw * ch > max_area:
            continue
        panels.append(
            Panel(
                x=int(x), y=int(y), w=int(cw), h=int(ch),
                centerX=int(x + cw // 2), centerY=int(y + ch // 2),
            )
        )

    # Sort: row by row. Group rows by y-bucket (10% of page height).
    bucket = max(int(h * 0.1), 20)
    panels.sort(key=lambda p: (p.y // bucket, p.x))

    # Dominant color (downsample → k-means free: just take mean of bright pixels)
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
