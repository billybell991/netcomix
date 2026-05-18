#!/usr/bin/env python3
"""
harvester/redetect_all.py

Full fresh re-detect of every page across every issue in Postgres.
Downloads each page image from R2, runs detect_panels(), writes clean
data back to Postgres AND to any matching local public/comics/ JSON files.

Nothing from before survives — all panel data is derived from the
current algorithm (Pass 1.7 containment filter + depth-2 H-split fallback).
Cover pages (index 0) always get panels=[].

Usage:
    Set env vars, then:
        python harvester/redetect_all.py

Required env vars:
    DATABASE_URL           — Postgres connection string
    R2_BUCKET              — Cloudflare R2 bucket name
    R2_ENDPOINT_URL        — R2 S3-compatible endpoint
    R2_ACCESS_KEY_ID       — R2 access key
    R2_SECRET_ACCESS_KEY   — R2 secret key
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

import boto3
import psycopg2

# Import detect_panels from sibling harvest.py
sys.path.insert(0, str(Path(__file__).parent))
from harvest import detect_panels  # noqa: E402  (after sys.path tweak)

# Root of the local static comics tree (for updating git-tracked issue.json files)
REPO_ROOT = Path(__file__).parent.parent
COMICS_DIR = REPO_ROOT / "public" / "comics"


# ──────────────────────────────────────────────────────────────────────────────

def _r2_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _panel_dict(p) -> dict:
    return {"x": p.x, "y": p.y, "w": p.w, "h": p.h,
            "centerX": p.centerX, "centerY": p.centerY}


def redetect_issue(issue_id: str, pages: list, s3, bucket: str, cur) -> int:
    """Re-detect all pages for one issue. Returns count of pages processed."""
    processed = 0

    with tempfile.TemporaryDirectory() as tmpdir:
        for i, page in enumerate(pages):
            # ── Cover: always panels=[] ──────────────────────────────────────
            if i == 0:
                page["panels"] = []
                continue

            r2_key = page.get("r2Key") or page.get("r2_key")
            if not r2_key:
                print(f"    page {i+1:3d}: no r2Key — skip")
                continue

            # ── Download ─────────────────────────────────────────────────────
            ext = Path(r2_key).suffix or ".jpg"
            local = Path(tmpdir) / f"p{i:03d}{ext}"
            try:
                s3.download_file(bucket, r2_key, str(local))
            except Exception as e:
                print(f"    page {i+1:3d}: download FAILED ({e})")
                continue

            # ── Detect ───────────────────────────────────────────────────────
            w, h, panels, dom_color = detect_panels(local)

            old_n = len(page.get("panels") or [])
            new_n = len(panels)
            delta = f"{old_n:2d}→{new_n:2d}"

            page["panels"] = [_panel_dict(p) for p in panels]
            # Always refresh dimensions + color from the actual image
            if w:
                page["width"] = w
            if h:
                page["height"] = h
            if dom_color:
                page["dominantColor"] = dom_color

            processed += 1
            print(f"    page {i+1:3d}: {delta} panels  ({Path(r2_key).name})")

    # ── Write back to Postgres ────────────────────────────────────────────────
    cur.execute(
        "UPDATE issues SET pages = %s WHERE id = %s",
        [json.dumps(pages), issue_id],
    )
    return processed


def update_local_json(issue_id: str, pages: list, cur) -> bool:
    """
    If a local public/comics/<series>/<issue>/issue.json exists, rewrite
    the panels fields there too so the git-tracked static files stay in sync.
    """
    cur.execute("SELECT series_id, title, cover_r2_key FROM issues WHERE id = %s", [issue_id])
    row = cur.fetchone()
    if not row:
        return False
    series_id, title, cover_r2_key = row

    # Try to find the local JSON by series_id / issue_id
    local_path = COMICS_DIR / series_id / issue_id / "issue.json"
    if not local_path.exists():
        return False

    try:
        with open(local_path) as f:
            manifest = json.load(f)

        # Update panels (and dimensions/color) for each page
        for i, pg_data in enumerate(pages):
            if i < len(manifest.get("pages", [])):
                manifest["pages"][i]["panels"] = pg_data.get("panels", [])
                if pg_data.get("width"):
                    manifest["pages"][i]["width"] = pg_data["width"]
                if pg_data.get("height"):
                    manifest["pages"][i]["height"] = pg_data["height"]
                if pg_data.get("dominantColor"):
                    manifest["pages"][i]["dominantColor"] = pg_data["dominantColor"]

        with open(local_path, "w") as f:
            json.dump(manifest, f, indent=2)
        return True
    except Exception as e:
        print(f"    (local JSON update failed: {e})")
        return False


# ──────────────────────────────────────────────────────────────────────────────

def main():
    required = ["DATABASE_URL", "R2_BUCKET", "R2_ENDPOINT_URL",
                "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}")
        sys.exit(1)

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    s3 = _r2_client()
    bucket = os.environ["R2_BUCKET"]

    cur.execute("SELECT id, pages FROM issues ORDER BY series_id, id")
    issues = cur.fetchall()

    total_issues = len(issues)
    total_pages = 0
    t_start = time.time()

    print(f"\n{'='*60}")
    print(f"Re-detecting panels for {total_issues} issues")
    print(f"{'='*60}\n")

    for idx, (issue_id, pages) in enumerate(issues, 1):
        page_count = len(pages)
        print(f"[{idx:2d}/{total_issues}] {issue_id}  ({page_count} pages)")

        processed = redetect_issue(issue_id, pages, s3, bucket, cur)
        conn.commit()
        total_pages += processed

        updated_local = update_local_json(issue_id, pages, cur)
        local_note = " + local JSON" if updated_local else ""
        elapsed = time.time() - t_start
        print(f"           → {processed} pages re-detected, DB committed{local_note}  [{elapsed:.0f}s]\n")

    cur.close()
    conn.close()

    elapsed = time.time() - t_start
    print(f"{'='*60}")
    print(f"Done. {total_pages} pages re-detected across {total_issues} issues in {elapsed:.0f}s.")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
