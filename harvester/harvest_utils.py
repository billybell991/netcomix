"""
Utility helpers shared by harvest_local.py.
Extracted from the old harvest_drive.py.
"""
from __future__ import annotations
import re
from pathlib import Path

try:
    import cv2
    import numpy as np
    HAS_CV = True
except ImportError:
    HAS_CV = False

PAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
JPEG_QUALITY = 85
MAX_PAGE_DIM = 1800  # downscale huge scans to keep repo size sane


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "untitled"


_ISSUE_RE = re.compile(
    r"^(.*?)\s+#?(\d+)(?:\s*[\(\[].*?[\)\]])*\s*\."
)


def parse_archive_name(name: str) -> tuple[str, str]:
    """Return (series_title, issue_label) from a CBZ/CBR filename."""
    m = _ISSUE_RE.match(name)
    if m:
        series = m.group(1).strip()
        return series, f"{series} #{m.group(2)}"
    stem = Path(name).stem
    return stem, stem


def _write_jpeg(raw: bytes, path: Path) -> None:
    """Decode image bytes, optionally downscale, write as JPEG."""
    if HAS_CV:
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is not None:
            h, w = img.shape[:2]
            scale = min(1.0, MAX_PAGE_DIM / max(w, h))
            if scale < 1.0:
                img = cv2.resize(img, (int(w * scale), int(h * scale)),
                                 interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(path), img, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
            return
    # Fallback: no OpenCV — write raw bytes
    path.write_bytes(raw)
