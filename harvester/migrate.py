"""
One-time migration: populate Postgres + R2 from existing static manifests + Drive.

Reads all public/comics/**/issue.json files that were already harvested, downloads
each page from Drive using the stored fileId, uploads to R2, then writes to Postgres.

Run once after setting up Railway Postgres and Cloudflare R2:

    cd harvester
    GOOGLE_OAUTH_CLIENT_ID=... \\
    GOOGLE_OAUTH_CLIENT_SECRET=... \\
    GOOGLE_OAUTH_REFRESH_TOKEN=... \\
    DATABASE_URL=postgresql://... \\
    R2_BUCKET=netcomix \\
    R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com \\
    R2_ACCESS_KEY_ID=... \\
    R2_SECRET_ACCESS_KEY=... \\
    R2_PUBLIC_URL=https://pub-<hash>.r2.dev \\
    python migrate.py

Panel data is preserved exactly as-is from the existing issue.json files — no
re-detection is performed. This is intentional: you've already tuned the algorithm.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

# Allow importing sibling modules
sys.path.insert(0, str(Path(__file__).parent))

from r2 import r2_configured, upload_jpeg, key_exists
from db_pg import pg_configured, upsert_series, upsert_issue

REPO_ROOT = Path(__file__).resolve().parent.parent
COMICS_DIR = REPO_ROOT / "public" / "comics"


def _drive_svc():
    from harvest_drive import drive_service  # type: ignore
    return drive_service()


def _download(svc, file_id: str, dest: Path) -> None:
    from harvest_drive import download  # type: ignore
    download(svc, file_id, dest)


def _api_bulk_migrate(series_list: list[dict], issues_list: list[dict]) -> None:
    """POST series + issues to the live API's /api/admin/migrate endpoint."""
    import urllib.request
    api_url = os.environ.get("API_URL", "https://netcomix-api-production.up.railway.app").rstrip("/")
    access_code = os.environ.get("ACCESS_CODE", "")
    url = f"{api_url}/api/admin/migrate"
    body = json.dumps({"series": series_list, "issues": issues_list}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if access_code:
        req.add_header("Authorization", f"Bearer {access_code}")
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    print(f"  → API responded: {result}")


def migrate() -> None:
    if not r2_configured():
        sys.exit("✗ R2 not configured — set R2_BUCKET, R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY")

    # Support direct Postgres (DATABASE_URL) or API endpoint (API_URL)
    use_api = bool(os.environ.get("API_URL")) or not pg_configured()
    if use_api:
        print("→ will write Postgres data via API endpoint")
    elif not pg_configured():
        sys.exit("✗ Set DATABASE_URL (direct) or API_URL (via API endpoint) for Postgres writes")

    # Load library.json for series-level metadata
    library_path = COMICS_DIR / "library.json"
    if not library_path.exists():
        sys.exit(f"✗ {library_path} not found — run the harvester first")
    library = json.loads(library_path.read_text(encoding="utf-8"))

    # Try connecting to Drive (optional — local files are preferred)
    svc = None
    try:
        print("→ connecting to Google Drive (optional) …")
        svc = _drive_svc()
    except Exception as e:
        print(f"  ! Drive unavailable ({e}) — will use local files only")

    # Accumulate DB payload
    all_series: list[dict] = []
    all_issues: list[dict] = []

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)

        for series_entry in library["series"]:
            sid = series_entry["id"]
            series_path = COMICS_DIR / series_entry["path"]
            if not series_path.is_dir():
                print(f"  ! series dir missing: {series_path}, skipping")
                continue

            issue_dirs = sorted(
                d for d in series_path.iterdir()
                if d.is_dir() and (d / "issue.json").exists()
            )
            if not issue_dirs:
                print(f"  ! no issues found for {sid}, skipping")
                continue

            print(f"\n● {series_entry['title']}  ({len(issue_dirs)} issue(s))")

            for issue_dir in issue_dirs:
                issue_data = json.loads((issue_dir / "issue.json").read_text(encoding="utf-8"))
                iid = issue_data["id"]
                print(f"  ↳ {iid}")

                pages_out: list[dict] = []
                cover_r2_key: str | None = None

                for idx, page in enumerate(issue_data["pages"]):
                    file_name = page["file"]
                    file_id = page.get("fileId")
                    r2_key = f"{sid}/{iid}/{file_name}"

                    local_page = issue_dir / file_name

                    if key_exists(r2_key):
                        print(f"      {file_name} → already in R2, skipping")
                    elif local_page.exists():
                        print(f"      {file_name} → uploading from local …", end="", flush=True)
                        upload_jpeg(local_page, r2_key)
                        print(" ✓")
                    elif file_id and svc:
                        local_path = tdp / file_name
                        print(f"      {file_name} → downloading from Drive …", end="", flush=True)
                        _download(svc, file_id, local_path)
                        upload_jpeg(local_path, r2_key)
                        local_path.unlink(missing_ok=True)
                        print(" ✓")
                    else:
                        # No local file and no Drive fileId — skip
                        print(f"      {file_name} → no local file or fileId, skipping R2 upload")
                        pages_out.append({
                            "file": file_name,
                            "r2Key": None,
                            "width": page.get("width", 0),
                            "height": page.get("height", 0),
                            "panels": page.get("panels", []),
                            "dominantColor": page.get("dominantColor"),
                        })
                        continue

                    if idx == 0:
                        cover_r2_key = r2_key

                    pages_out.append({
                        "file": file_name,
                        "r2Key": r2_key,
                        "width": page.get("width", 0),
                        "height": page.get("height", 0),
                        "panels": page.get("panels", []),
                        "dominantColor": page.get("dominantColor"),
                    })

                all_issues.append({
                    "id": iid,
                    "series_id": sid,
                    "title": issue_data["title"],
                    "page_count": len(pages_out),
                    "pages": pages_out,
                    "cover_r2_key": cover_r2_key,
                    "cover_drive_id": issue_data["pages"][0].get("fileId") if issue_data["pages"] else None,
                    "drive_file_id": None,
                })

            # Series metadata (after all issues processed)
            first_issue = issue_dirs[0]
            first_issue_data = json.loads((first_issue / "issue.json").read_text(encoding="utf-8"))
            first_cover_key = f"{sid}/{first_issue_data['id']}/{first_issue_data['cover']}"

            all_series.append({
                "id": sid,
                "title": series_entry["title"],
                "path": series_entry["path"],
                "issue_count": len(issue_dirs),
                "cover_r2_key": first_cover_key,
                "cover_drive_id": series_entry.get("coverFileId"),
                "drive_folder_id": None,
            })

    # ── Write to Postgres ─────────────────────────────────────────────────────
    print(f"\n→ writing {len(all_series)} series, {len(all_issues)} issues to Postgres …")
    if use_api:
        _api_bulk_migrate(all_series, all_issues)
    else:
        from db_pg import upsert_series, upsert_issue
        for s in all_series:
            upsert_series(
                series_id=s["id"], title=s["title"], path=s["path"],
                issue_count=s["issue_count"], cover_r2_key=s["cover_r2_key"],
                cover_drive_id=s["cover_drive_id"], drive_folder_id=s["drive_folder_id"],
            )
        for i in all_issues:
            upsert_issue(
                issue_id=i["id"], series_id=i["series_id"], title=i["title"],
                page_count=i["page_count"], pages=i["pages"],
                cover_r2_key=i["cover_r2_key"], cover_drive_id=i["cover_drive_id"],
                drive_file_id=i["drive_file_id"],
            )
        print("  → Postgres upserted ✓")

    print("\n✓ Migration complete!")


if __name__ == "__main__":
    migrate()
