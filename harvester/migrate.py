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


def migrate() -> None:
    if not r2_configured():
        sys.exit("✗ R2 not configured — set R2_BUCKET, R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY")
    if not pg_configured():
        sys.exit("✗ Postgres not configured — set DATABASE_URL")

    # Load library.json for series-level metadata
    library_path = COMICS_DIR / "library.json"
    if not library_path.exists():
        sys.exit(f"✗ {library_path} not found — run the harvester first")
    library = json.loads(library_path.read_text(encoding="utf-8"))

    need_drive = any(
        (COMICS_DIR / s["path"] / f).stat().st_size == 0  # placeholder
        for s in library["series"]
        for f in []
    )
    # We need Drive to download page images
    print("→ connecting to Google Drive …")
    svc = _drive_svc()

    series_by_id: dict[str, dict] = {s["id"]: s for s in library["series"]}

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

                    if key_exists(r2_key):
                        print(f"      {file_name} → already in R2, skipping download")
                    elif file_id:
                        local_path = tdp / file_name
                        print(f"      {file_name} → downloading from Drive …", end="", flush=True)
                        _download(svc, file_id, local_path)
                        upload_jpeg(local_path, r2_key)
                        local_path.unlink(missing_ok=True)
                        print(" ✓")
                    else:
                        # No Drive fileId — skip (may be a local-only page)
                        print(f"      {file_name} → no fileId, skipping R2 upload")
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

                upsert_issue(
                    issue_id=iid,
                    series_id=sid,
                    title=issue_data["title"],
                    page_count=len(pages_out),
                    pages=pages_out,
                    cover_r2_key=cover_r2_key,
                    cover_drive_id=issue_data["pages"][0].get("fileId") if issue_data["pages"] else None,
                )
                print(f"      → Postgres upserted ✓")

            # Upsert series after all its issues are done so issue_count is accurate
            first_issue = issue_dirs[0]
            first_issue_data = json.loads((first_issue / "issue.json").read_text(encoding="utf-8"))
            first_cover_key = f"{sid}/{first_issue_data['id']}/{first_issue_data['cover']}"

            upsert_series(
                series_id=sid,
                title=series_entry["title"],
                path=series_entry["path"],
                issue_count=len(issue_dirs),
                cover_r2_key=first_cover_key,
                cover_drive_id=series_entry.get("coverFileId"),
                drive_folder_id=None,
            )
            print(f"  → series Postgres upserted ✓")

    print("\n✓ Migration complete!")


if __name__ == "__main__":
    migrate()
