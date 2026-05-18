"""
redetect_issue.py — re-run panel detection for a single issue already in DB + R2.

Called by .github/workflows/redetect.yml with ISSUE_ID env var set.
Downloads existing page JPEGs from R2, re-runs detect_panels, updates DB.
Does NOT re-upload the images (they're already in R2) — only updates panel metadata.

Usage:
    ISSUE_ID=tales-from-the-crypt-v2-01-papercutz-2007-wildblue-zero \
    python harvester/redetect_issue.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

ISSUE_ID = os.environ.get("ISSUE_ID", "").strip()
if not ISSUE_ID:
    print("ERROR: ISSUE_ID env var is required", flush=True)
    sys.exit(1)

if not os.environ.get("DATABASE_URL"):
    print("ERROR: DATABASE_URL env var is required", flush=True)
    sys.exit(1)

_R2_VARS = ("R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
if not all(os.environ.get(v) for v in _R2_VARS):
    print("ERROR: R2 env vars required", flush=True)
    sys.exit(1)

import boto3
import psycopg2

from harvest_drive import detect_panels
from db_pg import upsert_issue

BUCKET = os.environ["R2_BUCKET"]


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def get_issue(issue_id: str) -> dict | None:
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, series_id, title, page_count, pages, cover_r2_key, drive_file_id "
                "FROM issues WHERE id = %s",
                (issue_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "series_id": row[1],
                "title": row[2],
                "page_count": row[3],
                "pages": json.loads(row[4]) if isinstance(row[4], str) else row[4],
                "cover_r2_key": row[5],
                "drive_file_id": row[6],
            }
    finally:
        conn.close()


def main() -> None:
    print(f"[redetect] issue_id={ISSUE_ID}", flush=True)

    issue = get_issue(ISSUE_ID)
    if not issue:
        print(f"[redetect] ERROR: issue '{ISSUE_ID}' not found in DB", flush=True)
        sys.exit(1)

    pages_meta: list[dict] = issue["pages"]
    print(f"[redetect] {len(pages_meta)} pages to re-process", flush=True)

    s3 = _s3()
    new_pages: list[dict] = []

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for idx, page in enumerate(pages_meta):
            r2_key = page.get("r2Key") or page.get("r2_key", "")
            filename = page.get("file", Path(r2_key).name)
            local_path = tdp / filename

            print(f"  [{idx+1}/{len(pages_meta)}] {filename}", flush=True)
            s3.download_file(BUCKET, r2_key, str(local_path))

            w, h, panels, dom = detect_panels(local_path)
            if idx == 0:
                panels = []  # cover page — no panels

            new_pages.append({
                "file": filename,
                "r2Key": r2_key,
                "width": w,
                "height": h,
                "panels": [asdict(pn) for pn in panels],
                "dominantColor": dom,
            })

    upsert_issue(
        issue_id=issue["id"],
        series_id=issue["series_id"],
        title=issue["title"],
        page_count=len(new_pages),
        pages=new_pages,
        cover_r2_key=issue.get("cover_r2_key"),
        drive_file_id=issue.get("drive_file_id"),
    )

    total_panels = sum(len(p["panels"]) for p in new_pages)
    print(f"[redetect] done — {len(new_pages)} pages, {total_panels} panels detected", flush=True)


if __name__ == "__main__":
    main()
