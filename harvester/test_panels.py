"""
Quick panel-detection audit against an already-extracted issue folder.

Usage (run from harvester/ dir):
    python test_panels.py ..\comics-source\red-room-001-2021-digital-phillywilly-empire-1yyGum

Prints each page, its panel count, and (x,y,w,h) for each detected panel.
Also loads the existing issue.json (if present) so you can compare old vs new.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harvest_drive import detect_panels

PAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: python test_panels.py <issue-folder>")

    folder = Path(sys.argv[1])
    if not folder.is_dir():
        sys.exit(f"not a directory: {folder}")

    pages = sorted(
        (p for p in folder.iterdir() if p.suffix.lower() in PAGE_EXTS),
        key=lambda p: p.name,
    )
    if not pages:
        sys.exit("no image files found")

    # Load existing issue.json for comparison (optional)
    old: dict[str, list] = {}
    ij = folder / "issue.json"
    if ij.exists():
        data = json.loads(ij.read_text())
        for pg in data.get("pages", []):
            old[pg["file"]] = pg.get("panels", [])

    print(f"\n{'Page':<14} {'OLD':>4}  {'NEW':>4}  Panels (x,y,w,h)")
    print("-" * 70)
    mismatches = 0
    for idx, p in enumerate(pages):
        w, h, panels, dom = detect_panels(p)
        # Cover (index 0) is always forced to [] in the harvester
        if idx == 0:
            panels = []
        new_count = len(panels)
        old_count = len(old.get(p.name, []))
        changed = "  ←" if new_count != old_count else ""
        if changed:
            mismatches += 1
        detail = "  " + ", ".join(f"({pn.x},{pn.y},{pn.w},{pn.h})" for pn in panels) if panels else ""
        print(f"{p.name:<14} {old_count:>4}  {new_count:>4}{changed}{detail}")

    print("-" * 70)
    print(f"Total pages: {len(pages)}   Changed: {mismatches}")


if __name__ == "__main__":
    main()
