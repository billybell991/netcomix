"""
harvest_r2_staging.py — process CBZ/CBR files from R2 staging/ prefix.

The Admin "Upload comics" feature stores archives at staging/{filename} in R2.
This script downloads them, runs the full harvest pipeline, writes results to
R2 + Postgres (same as harvest_drive.py), then deletes the staging objects.

Usage (called by scan.yml after the Drive scan step):
    python harvester/harvest_r2_staging.py

Required env vars (same as the rest of the harvester):
    R2_BUCKET, R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    DATABASE_URL
"""
from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

# ── env check ────────────────────────────────────────────────────────────────
_R2_VARS = ("R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
if not all(os.environ.get(v) for v in _R2_VARS):
    print("[staging] R2 not configured — skipping", flush=True)
    sys.exit(0)

import boto3  # type: ignore

sys.path.insert(0, str(Path(__file__).parent))
from harvest_drive import (
    ARCHIVE_EXTS,
    extract_pages,
    detect_panels,
    parse_archive_name,
    slugify,
    _page_to_dict,
)
from r2 import upload_jpeg as r2_upload_jpeg, upload_bytes as r2_upload_bytes  # type: ignore
from db_pg import pg_configured, upsert_issue, upsert_series  # type: ignore

BUCKET = os.environ["R2_BUCKET"]
STAGING_PREFIX = "staging/"


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def list_staging() -> list[str]:
    s3 = _s3()
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=STAGING_PREFIX):
        for obj in page.get("Contents", []):
            k = obj["Key"]
            filename = k[len(STAGING_PREFIX):]
            if filename and Path(filename).suffix.lower() in ARCHIVE_EXTS:
                keys.append(k)
    return keys


def download(key: str, dest: Path) -> None:
    _s3().download_file(BUCKET, key, str(dest))


def delete_staging(keys: list[str]) -> None:
    if not keys:
        return
    _s3().delete_objects(
        Bucket=BUCKET,
        Delete={"Objects": [{"Key": k} for k in keys]},
    )


def process_staging() -> None:
    staging_keys = list_staging()
    if not staging_keys:
        print("[staging] nothing to process", flush=True)
        return

    print(f"[staging] found {len(staging_keys)} file(s) to process", flush=True)
    processed_keys: list[str] = []

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for key in staging_keys:
            filename = key[len(STAGING_PREFIX):]
            print(f"\n[staging] • {filename}", flush=True)

            local_archive = tdp / filename
            download(key, local_archive)

            series_title, issue_label = parse_archive_name(filename)
            series_id = slugify(series_title)
            issue_id = slugify(Path(filename).stem)

            print(f"  series={series_id}  issue={issue_id}", flush=True)

            extracted_dir = tdp / issue_id
            pages = extract_pages(local_archive, extracted_dir)
            if not pages:
                print(f"  ! no pages extracted, skipping", flush=True)
                continue

            cover_r2_key: str | None = None
            pages_pg: list[dict] = []

            for idx, page_path in enumerate(pages):
                w, h, panels, dom = detect_panels(page_path)
                if idx == 0:
                    panels = []
                r2_key = f"{series_id}/{issue_id}/{page_path.name}"
                r2_upload_jpeg(page_path, r2_key)
                if idx == 0:
                    cover_r2_key = r2_key
                pages_pg.append({
                    "file": page_path.name,
                    "r2Key": r2_key,
                    "width": w,
                    "height": h,
                    "panels": [asdict(pn) for pn in panels],
                    "dominantColor": dom,
                })
                print(f"  ↳ {page_path.name}: {len(panels)} panels", flush=True)

            if pg_configured():
                upsert_series(
                    series_id=series_id,
                    title=series_title,
                    path=series_id,
                    issue_count=1,
                    cover_r2_key=cover_r2_key,
                )
                upsert_issue(
                    issue_id=issue_id,
                    series_id=series_id,
                    title=issue_label,
                    page_count=len(pages_pg),
                    pages=pages_pg,
                    cover_r2_key=cover_r2_key,
                )
                print(f"  [pg] upserted ✓", flush=True)
            else:
                print(f"  [pg] DATABASE_URL not set — skipping DB write", flush=True)

            processed_keys.append(key)

    # Clean up staging after all successful processing
    if processed_keys:
        delete_staging(processed_keys)
        print(f"\n[staging] deleted {len(processed_keys)} staging file(s) ✓", flush=True)


if __name__ == "__main__":
    process_staging()
