import json, shutil
from pathlib import Path
from datetime import datetime, timezone

COMICS = Path(__file__).resolve().parent.parent / "public" / "comics"
v2 = COMICS / "tales-from-the-crypt-v2"
v2_old = COMICS / "tales-from-the-crypt-v2-01-papercutz"

# Move issue 01 directory into the tales-from-the-crypt-v2 series dir
old_issue_dir = v2_old / "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero"
new_issue_dir = v2 / "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero"
if not new_issue_dir.exists():
    shutil.copytree(old_issue_dir, new_issue_dir)
    print(f"Copied issue 01 to {new_issue_dir}")
else:
    print("Issue 01 dir already exists in v2")

# Fix issue.json series field
ij_path = new_issue_dir / "issue.json"
ij = json.loads(ij_path.read_text())
ij["series"] = "tales-from-the-crypt-v2"
ij_path.write_text(json.dumps(ij, indent=2))
print("Fixed issue.json series field")

# Also copy page-001.jpg cover from issue 01 as series cover (first issue)
src_cover = new_issue_dir / "page-001.jpg"
dst_cover = v2 / "page-001.jpg"
shutil.copy2(src_cover, dst_cover)
print("Copied cover from issue 01")

# Rebuild series.json for tales-from-the-crypt-v2 with both issues
issues = []
for issue_dir in sorted(v2.iterdir()):
    ij_file = issue_dir / "issue.json"
    if not ij_file.exists():
        continue
    d = json.loads(ij_file.read_text())
    issues.append({
        "id": d["id"],
        "title": d["title"],
        "cover": d["cover"],
        "pageCount": len(d["pages"]),
        "path": f"tales-from-the-crypt-v2/{d['id']}",
    })
series_doc = {"id": "tales-from-the-crypt-v2", "title": "Tales from the Crypt v2", "issues": issues}
(v2 / "series.json").write_text(json.dumps(series_doc, indent=2))
print(f"Updated series.json with {len(issues)} issues")

# Rebuild full library.json from all series dirs
library_series = []
for sub in sorted(COMICS.iterdir()):
    if not sub.is_dir():
        continue
    sj = sub / "series.json"
    if not sj.exists():
        continue
    # Skip old mis-named series dirs
    if sub.name == "tales-from-the-crypt-v2-01-papercutz":
        print(f"Skipping old dir {sub.name}")
        continue
    if sub.name == "issue01":
        print(f"Skipping bare issue dir {sub.name}")
        continue
    sd = json.loads(sj.read_text())
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
(COMICS / "library.json").write_text(json.dumps(library, indent=2))
print(f"Wrote library.json with {len(library_series)} series")
print("Series:", [s["id"] for s in library_series])
