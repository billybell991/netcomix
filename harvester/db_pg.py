"""
Postgres write helpers for the NetComix harvester.

Activated when DATABASE_URL env var is present.
Uses psycopg2 for broad Railway/Heroku compatibility.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import datetime, timezone


def pg_configured() -> bool:
    return bool(os.environ.get("DATABASE_URL"))


def _conn():
    import psycopg2  # type: ignore
    return psycopg2.connect(os.environ["DATABASE_URL"])


def upsert_series(
    *,
    series_id: str,
    title: str,
    path: str,
    issue_count: int,
    cover_r2_key: str | None = None,
    cover_drive_id: str | None = None,
    drive_folder_id: str | None = None,
) -> None:
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO series
                    (id, title, path, issue_count, cover_r2_key, cover_drive_id,
                     drive_folder_id, generated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    title           = EXCLUDED.title,
                    path            = EXCLUDED.path,
                    issue_count     = EXCLUDED.issue_count,
                    cover_r2_key    = COALESCE(EXCLUDED.cover_r2_key, series.cover_r2_key),
                    cover_drive_id  = COALESCE(EXCLUDED.cover_drive_id, series.cover_drive_id),
                    drive_folder_id = COALESCE(EXCLUDED.drive_folder_id, series.drive_folder_id),
                    generated_at    = EXCLUDED.generated_at
                """,
                (
                    series_id, title, path, issue_count,
                    cover_r2_key, cover_drive_id, drive_folder_id,
                    datetime.now(timezone.utc),
                ),
            )
    finally:
        conn.close()


def upsert_issue(
    *,
    issue_id: str,
    series_id: str,
    title: str,
    page_count: int,
    pages: list[dict],
    cover_r2_key: str | None = None,
    cover_drive_id: str | None = None,
    drive_file_id: str | None = None,
) -> None:
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO issues
                    (id, series_id, title, page_count, pages,
                     cover_r2_key, cover_drive_id, drive_file_id, generated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    series_id      = EXCLUDED.series_id,
                    title          = EXCLUDED.title,
                    page_count     = EXCLUDED.page_count,
                    pages          = EXCLUDED.pages,
                    cover_r2_key   = COALESCE(EXCLUDED.cover_r2_key, issues.cover_r2_key),
                    cover_drive_id = COALESCE(EXCLUDED.cover_drive_id, issues.cover_drive_id),
                    drive_file_id  = COALESCE(EXCLUDED.drive_file_id, issues.drive_file_id),
                    generated_at   = EXCLUDED.generated_at
                """,
                (
                    issue_id, series_id, title, page_count,
                    json.dumps(pages),
                    cover_r2_key, cover_drive_id, drive_file_id,
                    datetime.now(timezone.utc),
                ),
            )
    finally:
        conn.close()
