"""Panel-gap QA: scan every page for layout anomalies that suggest a missed panel.

Heuristics (any one fires → flag the page):
  1. Row-gap: panels grouped by y-bucket; within a row, gap between adjacent
     panel right-edge and next panel left-edge > min_panel_w → missing neighbour.
  2. Row-right-edge: rightmost panel in a row ends > min_panel_w short of the
     inked bbox right edge → missing right-most panel.
  3. Row-left-edge: leftmost panel in a row starts > min_panel_w right of the
     inked bbox left edge → missing left-most panel.
  4. Stack-gap: vertical gap between rows > min_panel_h → missing full row.

Usage:
    python scripts/panel_gap_qa.py [series_dir...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "public" / "comics"


def scan_issue(issue_dir: Path) -> list[str]:
    ij = issue_dir / "issue.json"
    if not ij.exists():
        return []
    doc = json.loads(ij.read_text(encoding="utf-8"))
    findings: list[str] = []
    for page_idx, page in enumerate(doc["pages"]):
        panels = page.get("panels") or []
        if len(panels) < 2:
            continue  # splash / cover / single-panel pages are fine
        w = page["width"]
        h = page["height"]
        min_pw = w * 0.18
        min_ph = h * 0.10
        # Bucket by y (rows): same row if centerY within h*0.04 of bucket start
        bucket = max(int(h * 0.04), 16)
        rows: dict[int, list[dict]] = {}
        for p in panels:
            key = p["centerY"] // bucket
            rows.setdefault(key, []).append(p)
        # Sort rows by y, panels within a row by x
        sorted_rows = sorted(rows.values(), key=lambda r: min(p["y"] for p in r))
        # Inked bbox from union of all panels
        bbox_l = min(p["x"] for p in panels)
        bbox_r = max(p["x"] + p["w"] for p in panels)
        for row in sorted_rows:
            row.sort(key=lambda p: p["x"])
            # 1. row-gap (any row, any size)
            for a, b in zip(row, row[1:]):
                gap = b["x"] - (a["x"] + a["w"])
                if gap > min_pw:
                    findings.append(
                        f"  page {page_idx+1:3d}: row-gap {gap:.0f}px between panels "
                        f"x={a['x']}+{a['w']} and x={b['x']} (min_panel_w={min_pw:.0f})"
                    )
            # Row-edge checks only meaningful when the row has 2+ panels
            # (single-panel rows in a T-layout legitimately don't span full
            # width because they sit next to a tall panel in another row).
            if len(row) < 2:
                continue
            # 2. row-right edge
            right_short = bbox_r - (row[-1]["x"] + row[-1]["w"])
            if right_short > min_pw:
                findings.append(
                    f"  page {page_idx+1:3d}: row-right gap {right_short:.0f}px "
                    f"(last panel ends at {row[-1]['x']+row[-1]['w']}, bbox right={bbox_r})"
                )
            # 3. row-left edge
            left_short = row[0]["x"] - bbox_l
            if left_short > min_pw:
                findings.append(
                    f"  page {page_idx+1:3d}: row-left gap {left_short:.0f}px "
                    f"(first panel starts at {row[0]['x']}, bbox left={bbox_l})"
                )
        # 4. stack-gap between consecutive rows — only when the gap doesn't
        # overlap any panel in y (a tall panel on the side would y-overlap).
        row_bounds = [
            (min(p["y"] for p in r), max(p["y"] + p["h"] for p in r))
            for r in sorted_rows
        ]
        for (_, a_bot), (b_top, _) in zip(row_bounds, row_bounds[1:]):
            gap = b_top - a_bot
            if gap <= min_ph:
                continue
            # Suppress if any panel's y-range overlaps the gap (tall side panel)
            overlapped = any(
                p["y"] < b_top and (p["y"] + p["h"]) > a_bot
                for p in panels
            )
            if overlapped:
                continue
            findings.append(
                f"  page {page_idx+1:3d}: stack-gap {gap:.0f}px between rows "
                f"(min_panel_h={min_ph:.0f})"
            )
    return findings


def main() -> None:
    if len(sys.argv) > 1:
        series_dirs = [Path(a) for a in sys.argv[1:]]
    else:
        series_dirs = [d for d in PUBLIC.iterdir() if d.is_dir()]
    total = 0
    for series_dir in series_dirs:
        for issue_dir in sorted(series_dir.iterdir()):
            if not issue_dir.is_dir():
                continue
            findings = scan_issue(issue_dir)
            if findings:
                print(f"\n{issue_dir.name}:")
                for f in findings:
                    print(f)
                total += len(findings)
    print(f"\n{total} findings total")


if __name__ == "__main__":
    main()
