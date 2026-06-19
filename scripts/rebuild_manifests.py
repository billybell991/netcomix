"""Rebuild series.json and library.json from current public/comics/ structure."""
import json
from datetime import datetime, timezone
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public" / "comics"
SERIES_ID = "tales-from-the-crypt-v2"
SERIES_TITLE = "Tales from the Crypt v2"

series_dir = PUBLIC / SERIES_ID

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
        "path": f"{SERIES_ID}/{d['id']}",
    })

(series_dir / "series.json").write_text(
    json.dumps({"id": SERIES_ID, "title": SERIES_TITLE, "issues": issues_meta}, indent=2),
    encoding="utf-8",
)
print(f"series.json: {len(issues_meta)} issues")

library_series = []
for sub in sorted(PUBLIC.iterdir()):
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
(PUBLIC / "library.json").write_text(
    json.dumps(library, indent=2), encoding="utf-8"
)
print(f"library.json: {len(library_series)} series")
