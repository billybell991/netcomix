"""
Re-detect panels for an already-harvested issue using Gemini Vision.
Updates the panels array in public/comics/<series>/<issue>/issue.json.

Usage:
    python harvester/redetect_local.py <issue-id>
    python harvester/redetect_local.py tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero

The issue must already exist under public/comics/ with its page images.
Commits nothing — caller (GitHub Action or human) handles git.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harvest_utils import PAGE_EXTS  # type: ignore
from harvest import detect_panels as _opencv_detect  # type: ignore
from detect_gemini import detect_panels_gemini  # type: ignore

PUBLIC_COMICS = Path(__file__).resolve().parent.parent / "public" / "comics"


def find_issue_dir(issue_id: str) -> Path | None:
    for series_dir in PUBLIC_COMICS.iterdir():
        if not series_dir.is_dir():
            continue
        candidate = series_dir / issue_id
        if candidate.is_dir() and (candidate / "issue.json").exists():
            return candidate
    return None


def redetect(issue_id: str) -> int:
    issue_dir = find_issue_dir(issue_id)
    if not issue_dir:
        print(f"Issue not found: {issue_id}", file=sys.stderr)
        print(f"Searched under: {PUBLIC_COMICS}", file=sys.stderr)
        return 1

    manifest_path = issue_dir / "issue.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print(f"Re-detecting panels for: {issue_id}")
    pages = manifest.get("pages", [])
    changed = 0

    for idx, page in enumerate(pages):
        img_path = issue_dir / page["file"]
        if not img_path.exists():
            print(f"  ! Missing: {page['file']}")
            continue

        w = page.get("width", 0)
        h = page.get("height", 0)

        # Cover is always full-page
        if idx == 0:
            new_panels = []
        else:
            gemini = detect_panels_gemini(img_path, w, h)
            if gemini is not None:
                new_panels = [
                    {"x": p.x, "y": p.y, "w": p.w, "h": p.h,
                     "centerX": p.centerX, "centerY": p.centerY}
                    for p in gemini
                ]
                source = "gemini"
            else:
                _, _, opencv_panels, _ = _opencv_detect(img_path)
                new_panels = [
                    {"x": p.x, "y": p.y, "w": p.w, "h": p.h,
                     "centerX": p.centerX, "centerY": p.centerY}
                    for p in opencv_panels
                ]
                source = "opencv"

            old_count = len(page.get("panels", []))
            if old_count != len(new_panels):
                print(f"  {page['file']}: {old_count} → {len(new_panels)} panels [{source}]")
                changed += 1
            else:
                print(f"  {page['file']}: {len(new_panels)} panels (unchanged) [{source}]")

        page["panels"] = new_panels

    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\n✓ Updated {manifest_path}")
    print(f"  {changed} pages changed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python redetect_local.py <issue-id>")
    sys.exit(redetect(sys.argv[1]))
