"""
Backfill R2 + Postgres for issues that were already harvested to Drive
but whose pages were never uploaded to R2 and never written to Postgres.

For each issue in series.json (which has issueFileId → Drive):
  1. Download issue.json from Drive
  2. Download each page JPEG from Drive
  3. Upload each page to R2 at {series_id}/{issue_id}/{file}
  4. Upsert issue + series to Postgres

Run with all env vars set:
    DATABASE_URL=postgresql://...
    R2_BUCKET=netcomix
    R2_ENDPOINT_URL=https://...
    R2_ACCESS_KEY_ID=...
    R2_SECRET_ACCESS_KEY=...
    GOOGLE_OAUTH_CLIENT_ID=...
    GOOGLE_OAUTH_CLIENT_SECRET=...
    GOOGLE_OAUTH_REFRESH_TOKEN=...
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from r2 import r2_configured, upload_jpeg, key_exists
from db_pg import pg_configured, upsert_series, upsert_issue

REPO_ROOT = Path(__file__).resolve().parent.parent
COMICS_DIR = REPO_ROOT / "public" / "comics"
R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "https://pub-a6857c18bd4448e2b2e6351683e0272f.r2.dev")


def drive_svc():
    from harvest_drive import drive_service  # type: ignore
    return drive_service()


def download_file(svc, file_id: str, dest: Path) -> None:
    from harvest_drive import download  # type: ignore
    download(svc, file_id, dest)


def backfill() -> None:
    if not r2_configured():
        sys.exit("✗ R2 not configured")
    if not pg_configured():
        sys.exit("✗ DATABASE_URL not set")

    library = json.loads((COMICS_DIR / "library.json").read_text(encoding="utf-8"))

    print("→ connecting to Drive …")
    svc = drive_svc()

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)

        for series_entry in library["series"]:
            sid = series_entry["id"]
            series_path = COMICS_DIR / sid
            series_json_path = series_path / "series.json"
            if not series_json_path.exists():
                print(f"  ! no series.json for {sid}, skipping")
                continue

            series_data = json.loads(series_json_path.read_text(encoding="utf-8"))
            issues = series_data.get("issues", [])
            print(f"\n● {series_data['title']}  ({len(issues)} issues)")

            cover_r2_key_series: str | None = None

            for issue_entry in issues:
                iid = issue_entry["id"]
                issue_file_id = issue_entry.get("issueFileId")
                if not issue_file_id:
                    print(f"  ! {iid}: no issueFileId, skipping")
                    continue

                # Check if first page already in R2 — if so, skip to Postgres upsert only
                first_r2_key = f"{sid}/{iid}/page-001.jpg"
                already_in_r2 = key_exists(first_r2_key)

                print(f"  ↳ {iid}  {'(already in R2)' if already_in_r2 else ''}")

                # Download issue.json from Drive
                issue_json_local = tdp / f"{iid}-issue.json"
                try:
                    download_file(svc, issue_file_id, issue_json_local)
                    issue_data = json.loads(issue_json_local.read_text(encoding="utf-8"))
                except Exception as e:
                    print(f"    ! failed to fetch issue.json: {e}", file=sys.stderr)
                    continue

                pages = issue_data.get("pages", [])
                cover_file = issue_data.get("cover", "page-001.jpg")

                pages_pg: list[dict] = []
                cover_r2_key: str | None = None

                for idx, page in enumerate(pages):
                    page_file = page.get("file", f"page-{idx+1:03d}.jpg")
                    r2_key = f"{sid}/{iid}/{page_file}"

                    if already_in_r2 and key_exists(r2_key):
                        # Already uploaded — just collect metadata for Postgres
                        print(f"    [r2] {page_file} already exists, skipping upload")
                    else:
                        # Download from Drive and upload to R2
                        file_id = page.get("fileId")
                        if not file_id:
                            print(f"    ! {page_file}: no fileId, skipping", file=sys.stderr)
                            pages_pg.append({
                                "file": page_file,
                                "r2Key": None,
                                "width": page.get("width", 0),
                                "height": page.get("height", 0),
                                "panels": page.get("panels", []),
                                "dominantColor": page.get("dominantColor"),
                            })
                            continue
                        local_page = tdp / f"{iid}-{page_file}"
                        try:
                            download_file(svc, file_id, local_page)
                            upload_jpeg(local_page, r2_key)
                            local_page.unlink(missing_ok=True)
                            print(f"    [r2] {page_file} ✓")
                        except Exception as e:
                            print(f"    ! {page_file} upload failed: {e}", file=sys.stderr)
                            pages_pg.append({
                                "file": page_file,
                                "r2Key": None,
                                "width": page.get("width", 0),
                                "height": page.get("height", 0),
                                "panels": page.get("panels", []),
                                "dominantColor": page.get("dominantColor"),
                            })
                            continue

                    if page_file == cover_file and idx == 0:
                        cover_r2_key = r2_key

                    pages_pg.append({
                        "file": page_file,
                        "r2Key": r2_key,
                        "url": f"{R2_PUBLIC_URL}/{r2_key}",
                        "width": page.get("width", 0),
                        "height": page.get("height", 0),
                        "panels": page.get("panels", []),
                        "dominantColor": page.get("dominantColor"),
                    })

                if not cover_r2_key and pages_pg:
                    cover_r2_key = pages_pg[0].get("r2Key")

                # Upsert issue to Postgres
                upsert_issue(
                    issue_id=iid,
                    series_id=sid,
                    title=issue_entry["title"],
                    page_count=len(pages_pg),
                    pages=pages_pg,
                    cover_r2_key=cover_r2_key,
                    cover_drive_id=issue_entry.get("coverFileId"),
                    drive_file_id=issue_file_id,
                )
                print(f"    [pg] upserted ✓")

                if cover_series := cover_r2_key:
                    if cover_r2_key_series is None:
                        cover_r2_key_series = cover_series

            # Upsert series to Postgres
            upsert_series(
                series_id=sid,
                title=series_data["title"],
                path=sid,
                issue_count=len(issues),
                cover_r2_key=cover_r2_key_series,
                cover_drive_id=series_entry.get("coverFileId"),
            )
            print(f"  [pg] series upserted ({len(issues)} issues) ✓")

    print("\n✓ backfill complete")


if __name__ == "__main__":
    backfill()
