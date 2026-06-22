"""Regression tests for the splash-collapse rules added to `harvest.detect_panels`.

These tests synthesize tiny page images on the fly so they don't depend on
real comic art being in the repo.

Run from the repo root with:
    python -m pytest harvester/test_harvest_splash.py -v
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from harvest import detect_panels, detect_balloons_and_captions  # noqa: E402

W, H = 1171, 1799


def _save(img: np.ndarray) -> Path:
    """Write the image to a temp .jpg and return the Path.  Closes the OS-level
    file descriptor first so Windows lets the test unlink it later."""
    fd, name = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    tmp = Path(name)
    cv2.imwrite(str(tmp), img)
    return tmp


def _white_page() -> np.ndarray:
    return np.full((H, W, 3), 255, dtype=np.uint8)


def _black_page() -> np.ndarray:
    return np.zeros((H, W, 3), dtype=np.uint8)


# ── credits / colophon page (black bg, white text in 2 columns) ─────────

def test_dark_bg_two_text_columns_collapse_to_splash() -> None:
    """Reproduces Catacomb of Torment #12 page 2: black background with two
    columns of white text.  Dark-bg flood-fill detects each text column as a
    panel; the text-column guard should collapse to splash."""
    img = _black_page()
    # Two tall narrow "text columns" — bright pixels on black background.
    # Column 1: x=50–400, full height
    img[50:1749, 50:400] = 30   # mostly dark with some bright text rows
    for y in range(100, 1700, 30):
        img[y:y + 4, 60:390] = 240  # text rows
    # Column 2: x=600–1100, full height
    img[50:1749, 600:1100] = 30
    for y in range(100, 1700, 30):
        img[y:y + 4, 610:1090] = 240

    p = _save(img)
    try:
        _, _, panels, _ = detect_panels(p)
    finally:
        p.unlink(missing_ok=True)

    # The text-column guard must reject the 2 tall narrow "panels".
    assert panels == [], f"expected splash, got {len(panels)} panels"


# ── single-panel splash (covers < 25 % of page) ─────────────────────────

def test_single_small_panel_collapses_to_splash() -> None:
    """A page where projection-cut / dark-bg flood-fill finds exactly one
    panel covering ~18 % of the page (e.g. Catacomb #12 page 4, EC Comics
    logo splash).  Should collapse to full-page splash."""
    img = _white_page()
    # Single black-bordered "panel" centered, 1038 × 371 (~18 % of page).
    x, y, w, h = 69, 236, 1038, 371
    cv2.rectangle(img, (x, y), (x + w, y + h), (20, 20, 20), 3)
    # Some interior content so it's not just an empty box (mid-tone).
    img[y + 30:y + h - 30, x + 30:x + w - 30] = 180

    p = _save(img)
    try:
        _, _, panels, _ = detect_panels(p)
    finally:
        p.unlink(missing_ok=True)

    # 18 % of page area ⇒ below the new 25 % single-panel splash floor.
    assert panels == [], f"expected splash, got panel: {panels}"


# ── happy path: real 3-row layout survives ──────────────────────────────

def test_real_comic_page_still_detected() -> None:
    """Regression: a real multi-panel comic page from the committed TFTC v2
    test corpus must still produce ≥ 2 panels.  Verifies the new splash
    filters don't accidentally fire on legitimate panel layouts."""
    # Pick page 6 of TFTC v2 #01 — a known 4-panel page in the committed
    # ground-truth manifest.  If anyone moves or renames the test corpus
    # this assertion will tell us to update the test.
    repo_root = Path(__file__).resolve().parent.parent
    page = (
        repo_root
        / "public"
        / "comics"
        / "tales-from-the-crypt-v2"
        / "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero"
        / "page-006.jpg"
    )
    if not page.exists():
        import pytest
        pytest.skip(f"test corpus page not present: {page}")

    _, _, panels, _ = detect_panels(page)
    assert len(panels) >= 2, (
        f"splash filters wrongly collapsed a real multi-panel page "
        f"({page.name}) to {len(panels)} panels — check thresholds"
    )


# ── balloon fallback: tiny logo fragments collapse to splash ────────────

def test_balloon_fallback_low_coverage_returns_empty() -> None:
    """Reproduces Catacomb #12 page 37: white page with a single logo
    containing a handful of enclosed letter-interior regions.  The balloon
    fallback finds 3 small enclosed regions inside the logo.  Together they
    cover ~5 % of the page → must collapse to splash."""
    img = _white_page()
    # Three small blue "logo letter" shapes, each ~120×120 with hollow centres.
    for cx, cy in [(400, 300), (600, 600), (900, 900)]:
        cv2.rectangle(img, (cx, cy), (cx + 120, cy + 120), (180, 80, 30), 8)
        # Interior is white (enclosed by the dark border) → balloon-detector sees it.

    p = _save(img)
    try:
        balloons = detect_balloons_and_captions(p)
    finally:
        p.unlink(missing_ok=True)

    # Combined area ≈ 3 × (104²) ≈ 32 000 px ≈ 1.5 % of page → splash.
    assert balloons == [], f"expected splash, got {len(balloons)} balloons"
