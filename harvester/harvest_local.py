"""
Local harvester: process a single .cbz/.cbr from disk and write into public/comics/.
Runs panel detection via Gemini Vision (primary) with OpenCV fallback.

Usage:
    python harvester/harvest_local.py "path/to/Series 01 (Year).cbr"
    python harvester/harvest_local.py path/to/extracted-folder/
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# Ensure harvester dir is on sys.path
sys.path.insert(0, str(Path(__file__).parent))

from harvest_utils import PAGE_EXTS, slugify, parse_archive_name, _write_jpeg  # type: ignore
from harvest import detect_panels as _opencv_detect, Panel  # type: ignore
from detect_gemini import detect_panels_gemini  # type: ignore

SEVENZIP = next(
    (p for p in (
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
    ) if os.path.exists(p)),
    shutil.which("7z"),
)
UNAR = shutil.which("unar")

PUBLIC_COMICS = Path(__file__).resolve().parent.parent / "public" / "comics"


def detect_panels(image_path: Path) -> tuple[int, int, list[Panel], str]:
    """
    Detect panels using Gemini Vision first, falling back to OpenCV.
    Returns (width, height, panels, dominantColor).
    """
    # Get dimensions + dominant color from OpenCV regardless (cheap)
    w, h, opencv_panels, dom = _opencv_detect(image_path)

    # Try Gemini first
    gemini_panels = detect_panels_gemini(image_path, w, h)
    if gemini_panels is not None:
        source = "gemini"
        panels = gemini_panels
    else:
        source = "opencv"
        panels = opencv_panels

    print(f"    [{source}] {len(panels)} panels", end="")
    return w, h, panels, dom or "#222"


def extract_pages_local(archive: Path, out_dir: Path) -> list[Path]:
    """Extract pages from CBZ (zipfile) or CBR (unar/7z)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = archive.suffix.lower()
    pages: list[Path] = []

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        if ext in {".cbz", ".zip"}:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp)
        elif ext in {".cbr", ".rar"}:
            if UNAR:
                subprocess.run(
                    [UNAR, "-o", str(tmp), "-f", "-D", str(archive)],
                    check=True, capture_output=True,
                )
            elif SEVENZIP:
                subprocess.run(
                    [SEVENZIP, "x", "-y", f"-o{tmp}", str(archive)],
                    check=True, capture_output=True,
                )
            else:
                sys.exit("Neither unar nor 7-Zip found; install unar or p7zip-full")
        else:
            sys.exit(f"Unsupported archive: {archive}")

        all_imgs = sorted(
            (p for p in tmp.rglob("*") if p.is_file() and p.suffix.lower() in PAGE_EXTS),
            key=lambda p: p.name.lower(),
        )
        for i, src in enumerate(all_imgs, 1):
            dest = out_dir / f"page-{i:03d}.jpg"
            _write_jpeg(src.read_bytes(), dest)
            pages.append(dest)
    return pages


def _build_page_records(pages: list[Path]) -> list[dict]:
    records = []
    for idx, p in enumerate(pages):
        w, h, panels, dom = detect_panels(p)
        # Cover (index 0) is always full-page — never panel-snap
        if idx == 0:
            panels = []
        records.append({
            "file": p.name,
            "width": w,
            "height": h,
            "panels": [
                {"x": pn.x, "y": pn.y, "w": pn.w, "h": pn.h,
                 "centerX": pn.centerX, "centerY": pn.centerY}
                for pn in panels
            ],
            "dominantColor": dom,
        })
        print(f"  {p.name}: {len(panels)} panels")
    return records


def _write_manifests(series_id: str, series_title: str, issue_id: str,
                     issue_label: str, pages: list[Path],
                     page_records: list[dict]) -> None:
    """Write issue.json, series.json, and library.json."""
    series_dir = PUBLIC_COMICS / series_id
    issue_dir = series_dir / issue_id

    issue_doc = {
        "id": issue_id,
        "title": issue_label,
        "series": series_id,
        "cover": pages[0].name,
        "pages": page_records,
    }
    (issue_dir / "issue.json").write_text(
        json.dumps(issue_doc, indent=2), encoding="utf-8"
    )

    # Cover image at series level
    series_cover = series_dir / pages[0].name
    if not series_cover.exists():
        shutil.copy2(pages[0], series_cover)

    # series.json
    issues_meta = []
    for sub in sorted(series_dir.iterdir()):
        if not sub.is_dir():
            continue
        ij = sub / "issue.json"
        if not ij.exists():
            continue
        d = json.loads(ij.read_text(encoding="utf-8"))
        issues_meta.append({
            "id": d["id"],
            "title": d["title"],
            "cover": d["cover"],
            "pageCount": len(d["pages"]),
            "path": f"{series_id}/{d['id']}",
        })
    (series_dir / "series.json").write_text(
        json.dumps({"id": series_id, "title": series_title, "issues": issues_meta}, indent=2),
        encoding="utf-8",
    )

    # library.json
    library_series = []
    for sub in sorted(PUBLIC_COMICS.iterdir()):
        if not sub.is_dir():
            continue
        sj = sub / "series.json"
        if not sj.exists():
            continue
        try:
            sd = json.loads(sj.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        first = sd["issues"][0] if sd["issues"] else {}
        library_series.append({
            "id": sd["id"],
            "title": sd["title"],
            "cover": first.get("cover", ""),
            "issueCount": len(sd["issues"]),
            "path": sd["id"],
        })
    library = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "series": sorted(library_series, key=lambda s: s["title"]),
    }
    (PUBLIC_COMICS / "library.json").write_text(
        json.dumps(library, indent=2), encoding="utf-8"
    )
    print(f"✓ library.json updated ({len(library_series)} series)")


def harvest_local(archive: Path) -> None:
    if not archive.exists():
        sys.exit(f"Not found: {archive}")
    series_title, issue_label = parse_archive_name(archive.name)
    series_id = slugify(series_title)
    issue_id = slugify(archive.stem)

    print(f"→ {archive.name}")
    print(f"  series={series_id}  issue={issue_id}")

    series_dir = PUBLIC_COMICS / series_id
    issue_dir = series_dir / issue_id
    if issue_dir.exists():
        shutil.rmtree(issue_dir)
    issue_dir.mkdir(parents=True, exist_ok=True)

    pages = extract_pages_local(archive, issue_dir)
    if not pages:
        sys.exit("No pages extracted")

    records = _build_page_records(pages)
    _write_manifests(series_id, series_title, issue_id, issue_label, pages, records)


def harvest_folder(src_folder: Path) -> None:
    """Process a pre-extracted folder of page images."""
    if not src_folder.is_dir():
        sys.exit(f"Not a directory: {src_folder}")

    existing_json = src_folder / "issue.json"
    if existing_json.exists():
        meta = json.loads(existing_json.read_text(encoding="utf-8"))
        issue_id = meta.get("id", slugify(src_folder.name))
        series_id = meta.get("series", slugify(src_folder.name.split("-")[0]))
        issue_label = meta.get("title", src_folder.name)
        series_title = series_id.replace("-", " ").title()
    else:
        series_title, issue_label = parse_archive_name(src_folder.name + ".cbr")
        series_id = slugify(series_title)
        issue_id = slugify(src_folder.name)

    print(f">> {src_folder.name}/")
    print(f"  series={series_id}  issue={issue_id}")

    src_pages = sorted(
        (p for p in src_folder.iterdir() if p.suffix.lower() in PAGE_EXTS),
        key=lambda p: p.name.lower(),
    )
    if not src_pages:
        sys.exit("No image files found in folder")

    series_dir = PUBLIC_COMICS / series_id
    issue_dir = series_dir / issue_id
    if issue_dir.exists():
        shutil.rmtree(issue_dir)
    issue_dir.mkdir(parents=True, exist_ok=True)

    dest_pages: list[Path] = []
    for i, src in enumerate(src_pages, 1):
        dest = issue_dir / f"page-{i:03d}.jpg"
        _write_jpeg(src.read_bytes(), dest)
        dest_pages.append(dest)

    records = _build_page_records(dest_pages)
    _write_manifests(series_id, series_title, issue_id, issue_label, dest_pages, records)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python harvest_local.py <path-to-cbz-or-cbr-or-extracted-folder>")
    arg = Path(sys.argv[1])
    if arg.is_dir():
        harvest_folder(arg)
    else:
        harvest_local(arg)
