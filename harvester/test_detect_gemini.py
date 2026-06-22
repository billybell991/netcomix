"""Unit tests for the post-processing rules in `detect_gemini`.

These tests exercise the pure-Python `_postprocess` helper (no Gemini API,
no OpenCV).  They protect the contract that drives the harvester:

  - `[]` from Gemini ⇒ splash page (caller must NOT run the balloon fallback)
  - Tiny boxes that cover almost none of the page are dropped before that
    splash decision is made (e.g. text fragments on a credits page).
  - Legitimate multi-panel pages are returned unchanged.

Run from the repo root with:
    python -m pytest harvester/test_detect_gemini.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from detect_gemini import _postprocess  # noqa: E402
from harvest import Panel  # noqa: E402

W = 1171
H = 1799


def _p(x: int, y: int, w: int, h: int) -> Panel:
    return Panel(x, y, w, h, x + w // 2, y + h // 2)


# ── splash detection ─────────────────────────────────────────────────────

def test_empty_input_returns_empty() -> None:
    assert _postprocess([], W, H) == []


def test_two_small_text_blocks_become_splash() -> None:
    """Credits / TOC pages: Gemini returns 2 column-sized text boxes that
    together cover ~22 % of the page.  Should collapse to splash."""
    panels = [
        _p(0, 0, 417, 1799),    # left text column ~36 % of page
        _p(555, 0, 200, 600),   # small box ~6 %
    ]
    # Total ≈ 42 %.  Above the 25 % threshold ⇒ stays.
    assert len(_postprocess(panels, W, H)) == 2

    # Now shrink to a credits-like layout: two narrow text columns
    panels = [
        _p(50, 100, 200, 1000),    # ~9 %
        _p(700, 100, 200, 1000),   # ~9 %
    ]
    # Total ≈ 18 %, below 25 % ⇒ splash.
    assert _postprocess(panels, W, H) == []


def test_single_tiny_panel_becomes_splash() -> None:
    """EC Comics-logo splash page: Gemini returns a single ~370 px box
    inside an otherwise empty page → should collapse to splash."""
    panels = [_p(69, 236, 1038, 371)]  # ~18 %
    assert _postprocess(panels, W, H) == []


def test_logo_fragments_get_dropped() -> None:
    """Back-cover logo / DCP-style page: Gemini returns 3 tiny boxes inside
    a single big logo.  Each is under the 1.5 % per-panel floor → cleaned,
    then coverage falls to 0 % → splash."""
    panels = [
        _p(428, 96, 556, 242),   # 1.6 % barely passes
        _p(586, 710, 445, 281),  # 1.6 %
        _p(1250, 722, 184, 253), # 0.7 % dropped
    ]
    out = _postprocess(panels, W, H)
    # Only 2 small panels survive, total coverage ~3 % ⇒ splash.
    assert out == []


# ── happy path ───────────────────────────────────────────────────────────

def test_real_multi_panel_page_unchanged() -> None:
    """6-panel grid page (typical comic).  Coverage > 80 % ⇒ panels survive
    untouched."""
    panels = [
        _p(60,  81,  521, 604),
        _p(589, 83,  516, 602),
        _p(60,  692, 521, 588),
        _p(589, 692, 516, 605),
        _p(0,   1304, 1171, 394),
        _p(0,   170, 1171, 200),  # extra small panel (>1.5 %) survives
    ]
    out = _postprocess(panels, W, H)
    assert len(out) == 6


def test_three_panel_layout_survives() -> None:
    """Page 30-style: 3 horizontal-band panels covering most of the page."""
    panels = [
        _p(0, 0,    1171, 480),
        _p(0, 491,  1171, 840),
        _p(0, 1346, 1171, 453),
    ]
    out = _postprocess(panels, W, H)
    assert len(out) == 3
    # First and last panel preserved verbatim
    assert out[0].h == 480
    assert out[2].h == 453


# ── per-panel floor ──────────────────────────────────────────────────────

def test_below_floor_panels_dropped_but_rest_kept() -> None:
    """A real layout with one accidental sliver: drop the sliver, keep the rest."""
    panels = [
        _p(0, 0,    1171, 900),    # ~50 %, real big panel
        _p(0, 920,  1171, 800),    # ~45 %, real big panel
        _p(560, 5,  90, 90),       # sliver < 0.5 % — drop
    ]
    out = _postprocess(panels, W, H)
    assert len(out) == 2
    assert all(p.h >= 800 for p in out)
