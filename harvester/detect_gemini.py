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

Rules:
1. If this is a splash page, cover art, pin-up, or full-page illustration with no panel divisions → return {{"panels": []}}
2. Return {{"panels": []}} for text pages, credits, table of contents, or advertisement pages
3. Do NOT include page numbers, publisher logos, or outer white margins
4. All values are integers in pixels. Image is {width}x{height} pixels.
5. Expand each panel box to include its speech balloons and caption boxes
6. Minimum viable panel: 80×80 px
7. Order strictly: top-left first, then right across each row, then next row down"""


def detect_panels_gemini(image_path: Path, width: int, height: int) -> Optional[list[Panel]]:
    """
    Call Gemini Vision to detect comic panels.
    Returns list of Panel objects in reading order, or None if unavailable/failed.
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

        return panels

    except Exception as exc:
        print(f"  [Gemini] {image_path.name}: {exc}", file=sys.stderr)
        return None
