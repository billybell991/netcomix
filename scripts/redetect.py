"""One-shot: re-run panel detection on already-extracted pages in an issue dir
and rewrite its issue.json. Use after tuning detect_panels without re-extracting."""
import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "harvester"))
from harvest import detect_panels  # noqa: E402

if len(sys.argv) < 2:
    sys.exit("usage: python scripts/redetect.py <issue-dir>")

issue_dir = Path(sys.argv[1])
manifest = json.loads((issue_dir / "issue.json").read_text())
total = 0
for page in manifest["pages"]:
    img = issue_dir / page["file"]
    w, h, panels, dom = detect_panels(img)
    page["width"] = w
    page["height"] = h
    page["panels"] = [asdict(p) for p in panels]
    page["dominantColor"] = dom
    total += len(panels)
(issue_dir / "issue.json").write_text(json.dumps(manifest, indent=2))
print(f"Re-detected {len(manifest['pages'])} pages, {total} panels total")
