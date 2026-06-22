"""
Gemini Vision panel detection for NetComix.
Replaces OpenCV as the primary panel detector.
Falls back gracefully if API key not set or on any error.
"""
from __future__ import annotations
import base64
import json
import os
import sys
from pathlib import Path
from typing import Optional

try:
    from google import genai
    from google.genai import types as genai_types
    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False

# Import Panel from harvest.py
_here = Path(__file__).parent
sys.path.insert(0, str(_here))
from harvest import Panel  # type: ignore

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

_PROMPT = """Analyze this comic book page and identify all comic panels in reading order (Western: left to right in each row, rows top to bottom).

A comic panel is a framed region of sequential art. Include any speech balloons and caption/narrative boxes that belong to each panel within that panel's bounding box.

Return ONLY valid JSON — no markdown fences, no explanation:
{{"panels": [{{"x": 10, "y": 20, "w": 400, "h": 300}}, ...]}}

CRITICAL: Return {{"panels": []}} (empty list) for ANY of the following:
  - Splash page / pin-up / full-page single illustration (no panel divisions)
  - Credits / copyright / colophon / "indicia" pages
  - Table of contents / title pages / chapter dividers
  - Advertisement / promo / "next issue" / cross-promo pages
  - Publisher / studio / scanner logos that fill the page
  - Back cover / inside-back-cover pages
  - Any page where the "panels" you would return are merely text blocks,
    cover thumbnails, logos, or other non-sequential-art rectangles.
  - Bleed-art pages where the artist deliberately removed panel borders to
    show one large continuous scene (even if there are speech bubbles
    scattered across it). When in doubt, prefer one full-page snap.

Only return non-empty panel rectangles when the page has clear, separate
framed regions of sequential storytelling art (typical 2–9 panels per page).
A page where a "panel" would be a column of text, a credit list, or a tiny
fragment of art is NOT a panel — return [].

For mixed-layout pages (e.g. a top-half bleed/spread + a bottom-half grid of
small bordered panels), include BOTH: the big bleed region as one panel AND
each small bordered panel as its own panel.

Other rules:
1. Do NOT include page numbers, publisher logos, or outer white margins
2. All values are integers in pixels. Image is {width}x{height} pixels.
3. Expand each panel box to include its speech balloons and caption boxes
4. Minimum viable panel: 80×80 px
5. Order strictly: top-left first, then right across each row, then next row down"""


# Post-processing thresholds (applied to whatever Gemini returns)
#
# `_SPLASH_COVERAGE_THRESHOLD`: if the sum of panel areas is less than this
# fraction of the page area, treat the page as a splash and return [].
# Rationale: a real multi-panel page covers ≥35% of its area with panels;
# pages where Gemini returned only a couple of small text-block boxes (credits,
# logos, ads) typically cover <25%.  We pick 0.25 as a conservative line.
_SPLASH_COVERAGE_THRESHOLD = 0.25

# `_SMALL_PANEL_AREA_FRAC`: panels smaller than this fraction of the page are
# discarded as text-block / logo fragments before the splash-coverage check.
# 0.015 ≈ a 140×140 box on a 1170×1800 page — too small to be a real panel.
_SMALL_PANEL_AREA_FRAC = 0.015


def _postprocess(panels: list["Panel"], width: int, height: int) -> list["Panel"]:
    """Drop obvious junk and collapse to splash when coverage is too low.

    See module-level constants for the rationale behind each threshold.
    """
    if not panels:
        return panels
    page_area = max(1, width * height)
    cleaned = [p for p in panels if (p.w * p.h) / page_area >= _SMALL_PANEL_AREA_FRAC]
    if not cleaned:
        return []
    coverage = sum(p.w * p.h for p in cleaned) / page_area
    if coverage < _SPLASH_COVERAGE_THRESHOLD:
        # The remaining "panels" cover so little of the page that they're
        # almost certainly text fragments / logos on a splash page.  Treat as
        # full-page splash so the reader shows the page in one snap.
        return []
    return cleaned


def detect_panels_gemini(image_path: Path, width: int, height: int) -> Optional[list[Panel]]:
    """
    Call Gemini Vision to detect comic panels.
    Returns list of Panel objects in reading order, or None if unavailable/failed.
    An empty list is a positive splash-page verdict (page has no panels).
    """
    if not HAS_GEMINI:
        return None

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None

    try:
        # google-genai prefers GOOGLE_API_KEY env var over the explicit api_key param;
        # pin our key so we don't accidentally use a stale ambient GOOGLE_API_KEY.
        os.environ["GOOGLE_API_KEY"] = api_key
        client = genai.Client(api_key=api_key)

        img_bytes = image_path.read_bytes()
        suffix = image_path.suffix.lower()
        mime = "image/png" if suffix == ".png" else "image/jpeg"

        prompt = _PROMPT.format(width=width, height=height)

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                genai_types.Part.from_bytes(data=img_bytes, mime_type=mime),
                prompt,
            ],
        )

        text = response.text.strip()
        # Strip accidental markdown fences
        if text.startswith("```"):
            lines = text.splitlines()
            text = "\n".join(
                line for line in lines
                if not line.strip().startswith("```")
            )

        data = json.loads(text)
        raw = data.get("panels", [])

        panels: list[Panel] = []
        for p in raw:
            x = max(0, int(p["x"]))
            y = max(0, int(p["y"]))
            w = max(0, min(int(p["w"]), width - x))
            h = max(0, min(int(p["h"]), height - y))
            if w < 60 or h < 60:
                continue
            panels.append(Panel(x, y, w, h, x + w // 2, y + h // 2))

        return _postprocess(panels, width, height)

    except Exception as exc:
        print(f"  [Gemini] {image_path.name}: {exc}", file=sys.stderr)
        return None
