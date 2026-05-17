"""
NetComix Drive harvester.

Scans a Google Drive folder for .cbz/.cbr archives, extracts pages, detects panels,
and uploads JPEG pages + JSON manifests back to Drive. Idempotent — skips issues
that already have an issue.json sibling.

Layout in Drive (managed by this script):
  <root>/
    library.json                            ← rewritten on every scan
    <series-folder>/
      series.json                           ← rewritten when series changes
      Series Name 01 (1985).cbz             ← raw archive (you drop these in)
      Series Name 01 (1985)/                ← auto-created
        issue.json
        page-001.jpg
        page-002.jpg
        ...
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
import rarfile

SCOPES = ["https://www.googleapis.com/auth/drive"]
ARCHIVE_EXTS = {".cbz", ".zip", ".cbr", ".rar"}
PAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
JPEG_QUALITY = 85
MAX_PAGE_DIM = 1800  # downscale huge scans


# ─── Data classes ────────────────────────────────────────────────────────

@dataclass
class Panel:
    x: int
    y: int
    w: int
    h: int
    centerX: int
    centerY: int


@dataclass
class PageOut:
    file: str
    fileId: str
    width: int
    height: int
    panels: list[Panel]
    dominantColor: str | None = None


# ─── Drive helpers ───────────────────────────────────────────────────────

def drive_service():
    """Build a Drive client using an OAuth refresh token (acts as the user)."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    client_id = os.environ["GOOGLE_OAUTH_CLIENT_ID"]
    client_secret = os.environ["GOOGLE_OAUTH_CLIENT_SECRET"]
    refresh_token = os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"]
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def list_children(svc, parent_id: str) -> list[dict]:
    out, page_token = [], None
    while True:
        resp = svc.files().list(
            q=f"'{parent_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType, size)",
            pageSize=1000,
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        out.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return out


def find_child(svc, parent_id: str, name: str) -> dict | None:
    safe = name.replace("'", "\\'")
    resp = svc.files().list(
        q=f"'{parent_id}' in parents and name = '{safe}' and trashed = false",
        fields="files(id, name, mimeType)",
        pageSize=1,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    return files[0] if files else None


def ensure_folder(svc, parent_id: str, name: str) -> str:
    existing = find_child(svc, parent_id, name)
    if existing and existing["mimeType"] == "application/vnd.google-apps.folder":
        return existing["id"]
    body = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    f = svc.files().create(body=body, fields="id", supportsAllDrives=True).execute()
    return f["id"]


def upload_file(svc, parent_id: str, name: str, local_path: Path, mime: str, replace: bool = True) -> str:
    from googleapiclient.http import MediaFileUpload
    media = MediaFileUpload(str(local_path), mimetype=mime, resumable=False)
    existing = find_child(svc, parent_id, name) if replace else None
    if existing:
        f = svc.files().update(fileId=existing["id"], media_body=media, supportsAllDrives=True, fields="id").execute()
    else:
        body = {"name": name, "parents": [parent_id]}
        f = svc.files().create(body=body, media_body=media, fields="id", supportsAllDrives=True).execute()
    # Ensure anyone-with-link can view (for PWA fetches via API key)
    try:
        svc.permissions().create(
            fileId=f["id"],
            body={"type": "anyone", "role": "reader"},
            supportsAllDrives=True,
        ).execute()
    except Exception as e:
        # This is fatal: without public perms the PWA cannot read the file via API key.
        raise RuntimeError(
            f"Failed to make {name} publicly readable. The PWA will not be able to load it. "
            f"Underlying error: {e}"
        ) from e
    return f["id"]


def upload_json(svc, parent_id: str, name: str, data: dict) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(data, tmp, indent=2)
        tmp_path = Path(tmp.name)
    try:
        return upload_file(svc, parent_id, name, tmp_path, "application/json")
    finally:
        tmp_path.unlink(missing_ok=True)


def download(svc, file_id: str, dest: Path) -> None:
    from googleapiclient.http import MediaIoBaseDownload
    req = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    with dest.open("wb") as fh:
        dl = MediaIoBaseDownload(fh, req)
        done = False
        while not done:
            _, done = dl.next_chunk()


# ─── Archive extraction ──────────────────────────────────────────────────

def extract_pages(archive: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = archive.suffix.lower()
    pages: list[Path] = []
    if ext in {".cbz", ".zip"}:
        with zipfile.ZipFile(archive) as zf:
            names = sorted(n for n in zf.namelist() if Path(n).suffix.lower() in PAGE_EXTS)
            for i, name in enumerate(names, 1):
                data = zf.read(name)
                p = out_dir / f"page-{i:03d}.jpg"
                _write_jpeg(data, p)
                pages.append(p)
    elif ext in {".cbr", ".rar"}:
        with rarfile.RarFile(archive) as rf:
            names = sorted(n for n in rf.namelist() if Path(n).suffix.lower() in PAGE_EXTS)
            for i, name in enumerate(names, 1):
                data = rf.read(name)
                p = out_dir / f"page-{i:03d}.jpg"
                _write_jpeg(data, p)
                pages.append(p)
    else:
        print(f"  ! Unsupported archive type: {archive.name}", file=sys.stderr)
    return pages


def _write_jpeg(raw: bytes, path: Path) -> None:
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        path.write_bytes(raw)  # fallback: dump as-is
        return
    h, w = img.shape[:2]
    scale = min(1.0, MAX_PAGE_DIM / max(w, h))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), img, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])


# ─── Panel detection ─────────────────────────────────────────────────────

def detect_panels(image_path: Path) -> tuple[int, int, list[Panel], str]:
    """Delegates to harvest.py's projection-cut algorithm.

    The old contour-based approach failed completely on dark-background pages
    (e.g. Red Room) because it looks for light content blobs — which don't
    exist when the panels themselves have dark art.  The projection-cut finds
    gutters (light strips between panels) and is robust to both light and
    dark page styles.  The Pass-2 false-positive filters (CV, grid, coverage,
    hard cap) are all inside harvest.detect_panels already.
    """
    import sys as _sys
    import os as _os
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    from harvest import detect_panels as _projection_cut  # type: ignore
    w, h, raw, dom = _projection_cut(image_path)
    # Normalise Panel type (both namedtuples have same fields; re-wrap for safety)
    panels = [Panel(p.x, p.y, p.w, p.h, p.centerX, p.centerY) for p in raw]
    return w, h, panels, dom or "#222"


# ─── Series / issue parsing ──────────────────────────────────────────────

ISSUE_RE = re.compile(r"^(.*?)\s+(\d+)(?:\s*\(.*\))?\s*\.")  # "Savage Tales 01 (1985).cbr" → ("Savage Tales", "01")


def parse_archive_name(name: str) -> tuple[str, str]:
    """Return (series_title, issue_label). Falls back to (stem, stem)."""
    m = ISSUE_RE.match(name)
    if m:
        return m.group(1).strip(), f"{m.group(1).strip()} #{m.group(2)}"
    stem = Path(name).stem
    return stem, stem


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "untitled"


# ─── Main harvest loop ───────────────────────────────────────────────────

def harvest(root_folder_id: str) -> None:
    svc = drive_service()
    print(f"→ scanning Drive folder {root_folder_id}")
    children = list_children(svc, root_folder_id)
    # archives can be at root or one-folder-deep in a series-named folder
    archives: list[tuple[dict, str | None]] = []
    for c in children:
        if c["mimeType"] == "application/vnd.google-apps.folder":
            # walk into series folders for archives
            for sub in list_children(svc, c["id"]):
                if Path(sub["name"]).suffix.lower() in ARCHIVE_EXTS:
                    archives.append((sub, c["id"]))  # parent = series folder
        elif Path(c["name"]).suffix.lower() in ARCHIVE_EXTS:
            archives.append((c, None))  # parent = root → infer series from name

    # Optional cap (handy for proof-of-concept runs).
    limit_raw = os.environ.get("LIMIT", "").strip()
    if limit_raw:
        try:
            limit = int(limit_raw)
            if limit > 0:
                archives = archives[:limit]
                print(f"  (LIMIT={limit} — processing only the first {limit} archive(s))")
        except ValueError:
            print(f"  ! ignoring non-numeric LIMIT={limit_raw!r}", file=sys.stderr)

    series_map: dict[str, dict] = {}  # series_id → {entry, issues:[]}
    flush_counter = 0

    def maybe_flush(force: bool = False) -> None:
        nonlocal flush_counter
        flush_counter += 1
        if force or flush_counter % 3 == 0:
            _publish_manifest(svc, root_folder_id, series_map)

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for archive_file, parent_folder_id in archives:
            series_title, issue_label = parse_archive_name(archive_file["name"])
            series_id = slugify(series_title)
            # Disambiguate flat vs nested layouts by prefixing parent folder id (truncated) when nested.
            base_iid = slugify(Path(archive_file["name"]).stem)
            issue_id = f"{base_iid}-{parent_folder_id[:6]}" if parent_folder_id else base_iid
            print(f"\n• {archive_file['name']}  →  series={series_id}  issue={issue_id}")

            # Find/create the series folder in Drive
            series_folder_id = parent_folder_id or ensure_folder(svc, root_folder_id, series_title)

            # Issue subfolder
            issue_folder_id = ensure_folder(svc, series_folder_id, issue_id)

            # Idempotency: skip if issue.json already present AND its cover image still exists
            existing = find_child(svc, issue_folder_id, "issue.json")
            if existing:
                existing_json = tdp / f"{issue_id}-existing.json"
                download(svc, existing["id"], existing_json)
                try:
                    data = json.loads(existing_json.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    print("  ! issue.json corrupt, will re-harvest", file=sys.stderr)
                    data = None
                if data:
                    cover_file = data.get("cover", "page-001.jpg")
                    cover_node = find_child(svc, issue_folder_id, cover_file)
                    if cover_node is None:
                        print("  ! cover file missing in Drive, will re-harvest", file=sys.stderr)
                    else:
                        page_count = len(data.get("pages", []))
                        _register_issue(series_map, series_id, series_title, series_folder_id,
                                        issue_id, issue_label, page_count, cover_file, cover_node["id"],
                                        existing["id"])
                        print("  ↳ already harvested, skipping")
                        maybe_flush()
                        continue

            # Download archive locally
            local_archive = tdp / archive_file["name"]
            download(svc, archive_file["id"], local_archive)

            # Extract
            extracted_dir = tdp / issue_id
            pages = extract_pages(local_archive, extracted_dir)
            if not pages:
                print(f"  ! no pages extracted, skipping", file=sys.stderr)
                continue

            # Detect panels + upload pages
            page_outs: list[PageOut] = []
            for idx, page_path in enumerate(pages):
                w, h, panels, dom = detect_panels(page_path)
                # Cover (first page, index 0) is always a full-page splash — never panel-snap.
                if idx == 0:
                    panels = []
                page_file_id = upload_file(svc, issue_folder_id, page_path.name, page_path, "image/jpeg")
                page_outs.append(PageOut(
                    file=page_path.name,
                    fileId=page_file_id,
                    width=w,
                    height=h,
                    panels=panels,
                    dominantColor=dom,
                ))
                print(f"  ↳ {page_path.name}: {len(panels)} panels")

            # Write issue.json
            issue_data = {
                "id": issue_id,
                "title": issue_label,
                "series": series_id,
                "cover": page_outs[0].file,
                "pages": [_page_to_dict(p) for p in page_outs],
            }
            issue_file_id = upload_json(svc, issue_folder_id, "issue.json", issue_data)
            # Static mirror for the PWA — manifest in repo, images in Drive.
            repo_root = Path(__file__).resolve().parent.parent
            static_issue_dir = repo_root / "public" / "comics" / series_id / issue_id
            static_issue_dir.mkdir(parents=True, exist_ok=True)
            with (static_issue_dir / "issue.json").open("w", encoding="utf-8") as fh:
                json.dump(issue_data, fh, indent=2)
            _register_issue(series_map, series_id, series_title, series_folder_id,
                            issue_id, issue_label, len(page_outs),
                            page_outs[0].file, page_outs[0].fileId, issue_file_id)

            # Flush manifest after each newly-harvested issue so the PWA sees progress live.
            maybe_flush(force=True)

    # Final flush (also covers the case where every issue was skipped).
    _publish_manifest(svc, root_folder_id, series_map)


def _publish_manifest(svc, root_folder_id: str, series_map: dict) -> None:
    # Static manifest directory at repo public/comics — committed back by the
    # workflow so the PWA loads tiny JSON from GitHub Pages while images come
    # from Drive. Avoids the "folder must be publicly listable" requirement.
    repo_root = Path(__file__).resolve().parent.parent
    static_root = repo_root / "public" / "comics"
    static_root.mkdir(parents=True, exist_ok=True)

    library_series = []
    for sid, s in series_map.items():
        s["issues"].sort(key=lambda i: i["id"])
        series_doc = {"id": sid, "title": s["title"], "issues": s["issues"]}
        series_file_id = upload_json(svc, s["folderId"], "series.json", series_doc)
        # Also write static copy
        (static_root / sid).mkdir(parents=True, exist_ok=True)
        with (static_root / sid / "series.json").open("w", encoding="utf-8") as fh:
            json.dump(series_doc, fh, indent=2)
        first = s["issues"][0] if s["issues"] else {}
        library_series.append({
            "id": sid,
            "title": s["title"],
            "cover": first.get("cover", ""),
            "coverFileId": first.get("coverFileId", ""),
            "issueCount": len(s["issues"]),
            "path": sid,
            "seriesFileId": series_file_id,
        })

    library_doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "series": sorted(library_series, key=lambda s: s["title"]),
    }
    # Merge with any pre-existing entries (e.g. test fixtures like demo-series
    # that live in the repo and aren't sourced from Drive). Drive results take
    # priority — but anything not currently in Drive is preserved so existing
    # static fixtures keep working after a scan rewrite.
    existing_path = static_root / "library.json"
    if existing_path.exists():
        try:
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
            drive_ids = {s["id"] for s in library_series}
            for s in existing.get("series", []):
                if s.get("id") and s["id"] not in drive_ids:
                    library_doc["series"].append(s)
            library_doc["series"].sort(key=lambda s: s["title"])
        except Exception as e:
            print(f"  ! could not merge existing library.json: {e}", file=sys.stderr)
    upload_json(svc, root_folder_id, "library.json", library_doc)
    with existing_path.open("w", encoding="utf-8") as fh:
        json.dump(library_doc, fh, indent=2)
    print(f"  ✓ manifest flushed ({len(library_doc['series'])} series total)")


def _register_issue(series_map, sid, stitle, sfolder, iid, ilabel, page_count, cover_file, cover_id, issue_id):
    series_map.setdefault(sid, {"title": stitle, "folderId": sfolder, "issues": []})
    series_map[sid]["issues"].append({
        "id": iid,
        "title": ilabel,
        "cover": cover_file,
        "coverFileId": cover_id,
        "pageCount": page_count,
        "path": f"{sid}/{iid}",
        "issueFileId": issue_id,
    })


def _page_to_dict(p: PageOut) -> dict:
    d = asdict(p)
    d["panels"] = [asdict(pn) for pn in p.panels]
    return d


if __name__ == "__main__":
    folder = os.environ.get("DRIVE_FOLDER_ID") or (sys.argv[1] if len(sys.argv) > 1 else None)
    if not folder:
        print("usage: DRIVE_FOLDER_ID=<id> python harvest_drive.py", file=sys.stderr)
        sys.exit(2)
    harvest(folder)
