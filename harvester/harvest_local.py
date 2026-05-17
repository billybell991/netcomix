"""
Local harvester: process a single .cbz/.cbr from disk and write into public/comics/.

Reuses extraction + panel detection from harvest_drive.py but writes to local
filesystem instead of Drive. For proof-of-concept / offline testing.

Usage:
    python harvester/harvest_local.py "path/to/Series 01 (Year).cbr"
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

from harvest_drive import (
    PAGE_EXTS,
    detect_panels,
    parse_archive_name,
    slugify,
    _write_jpeg,
)

SEVENZIP = next(
    (p for p in (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe")
     if os.path.exists(p)),
    None,
)


def extract_pages_local(archive: Path, out_dir: Path) -> list[Path]:
    """Extract pages using 7z (works for both cbz and cbr)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = archive.suffix.lower()
    pages: list[Path] = []

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        if ext in {".cbz", ".zip"}:
            # Use zipfile directly — no external tool needed
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp)
        elif ext in {".cbr", ".rar"}:
            if not SEVENZIP:
                sys.exit("7-Zip not found; install it or use a .cbz file")
            subprocess.run(
                [SEVENZIP, "x", "-y", f"-o{tmp}", str(archive)],
                check=True, capture_output=True,
            )
        else:
            sys.exit(f"unsupported archive: {archive}")

        # Walk extracted tree, collect image files in name order
        all_imgs = sorted(
            (p for p in tmp.rglob("*") if p.is_file() and p.suffix.lower() in PAGE_EXTS),
            key=lambda p: p.name.lower(),
        )
        for i, src in enumerate(all_imgs, 1):
            dest = out_dir / f"page-{i:03d}.jpg"
            _write_jpeg(src.read_bytes(), dest)
            pages.append(dest)
    return pages

PUBLIC_COMICS = Path(__file__).resolve().parent.parent / "public" / "comics"


def harvest_local(archive: Path) -> None:
    if not archive.exists():
        sys.exit(f"not found: {archive}")
    series_title, issue_label = parse_archive_name(archive.name)
    series_id = slugify(series_title)
    issue_id = slugify(archive.stem)

    print(f"→ {archive.name}")
    print(f"  series={series_id} issue={issue_id}")

    series_dir = PUBLIC_COMICS / series_id
    issue_dir = series_dir / issue_id
    if issue_dir.exists():
        shutil.rmtree(issue_dir)
    issue_dir.mkdir(parents=True, exist_ok=True)

    pages = extract_pages_local(archive, issue_dir)
    if not pages:
        sys.exit("no pages extracted")

    page_records = []
    for idx, p in enumerate(pages):
        w, h, panels, dom = detect_panels(p)
        # Cover (first page, index 0) is always a full-page splash — never panel-snap.
        if idx == 0:
            panels = []
        page_records.append({
            "file": p.name,
            "width": w,
            "height": h,
            "panels": [{"x": pn.x, "y": pn.y, "w": pn.w, "h": pn.h,
                        "centerX": pn.centerX, "centerY": pn.centerY} for pn in panels],
            "dominantColor": dom,
        })
        print(f"  ↳ {p.name}: {len(panels)} panels")

    issue_doc = {
        "id": issue_id,
        "title": issue_label,
        "series": series_id,
        "cover": pages[0].name,
        "pages": page_records,
    }
    (issue_dir / "issue.json").write_text(json.dumps(issue_doc, indent=2), encoding="utf-8")

    # Copy cover up to series-level so LibraryView's coverUrl(series.path, file) resolves.
    series_cover = series_dir / pages[0].name
    if not series_cover.exists():
        shutil.copy2(pages[0], series_cover)

    # series.json — collect any existing issues alongside this one
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
    series_doc = {"id": series_id, "title": series_title, "issues": issues_meta}
    (series_dir / "series.json").write_text(json.dumps(series_doc, indent=2), encoding="utf-8")

    # library.json — rebuild from every series dir
    library_series = []
    for sub in sorted(PUBLIC_COMICS.iterdir()):
        if not sub.is_dir():
            continue
        sj = sub / "series.json"
        if not sj.exists():
            continue
        sd = json.loads(sj.read_text(encoding="utf-8"))
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
    (PUBLIC_COMICS / "library.json").write_text(json.dumps(library, indent=2), encoding="utf-8")
    print(f"✓ wrote {PUBLIC_COMICS / 'library.json'} ({len(library_series)} series)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python harvester/harvest_local.py <path-to-cbz-or-cbr>")
    harvest_local(Path(sys.argv[1]))
