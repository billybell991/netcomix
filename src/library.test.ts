import { describe, expect, it } from "vitest";
import type { IssueManifest, PageManifest, Panel, FocusRegion } from "./types";
import { applyZoneGrid, isDegeneratePage, montagePage, normalizeMontagePages } from "./library";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePanel(x: number, y: number, w: number, h: number): Panel {
  return { x, y, w, h, centerX: x + Math.round(w / 2), centerY: y + Math.round(h / 2) };
}

function makePage(width: number, height: number, panels: Panel[]): PageManifest {
  return { file: "page.jpg", width, height, panels };
}

function makeIssue(pages: PageManifest[]): IssueManifest {
  return { id: "test", title: "Test", series: "test", cover: "cover.jpg", pages };
}

// Run applyZoneGrid on a single non-cover page and return the resulting panels.
// pageIndex=0 would be cover; pass idx=1 by building a 2-page issue.
function zonePage(width: number, height: number): Panel[] {
  const cover = makePage(width, height, []);
  const page  = makePage(width, height, [makePanel(0, 0, 100, 100)]); // original panels ignored
  const result = applyZoneGrid(makeIssue([cover, page]));
  return result.pages[1].panels;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const W = 1291;
const H = 2010;
const zoneW = Math.floor(W / 2); // 645
const zoneH = Math.floor(H / 3); // 670

// ─── Zone count ───────────────────────────────────────────────────────────────

describe("applyZoneGrid — zone count", () => {
  it("non-cover page always gets exactly 6 panels", () => {
    const zones = zonePage(W, H);
    expect(zones).toHaveLength(6);
  });

  it("ignores whatever panel data was in the original issue.json", () => {
    // The old issue.json had complex panel arrays — they should be discarded
    const cover = makePage(W, H, []);
    const page  = makePage(W, H, [makePanel(0, 0, 100, 100), makePanel(200, 200, 50, 50)]);
    const result = applyZoneGrid(makeIssue([cover, page]));
    expect(result.pages[1].panels).toHaveLength(6);
  });
});

// ─── Cover rule ───────────────────────────────────────────────────────────────

describe("applyZoneGrid — cover rule", () => {
  it("page index 0 always has panels: [] (full-page splash)", () => {
    const result = applyZoneGrid(makeIssue([makePage(W, H, [makePanel(0, 0, W, H)])]));
    expect(result.pages[0].panels).toHaveLength(0);
  });

  it("page index 1+ gets zones applied", () => {
    const cover = makePage(W, H, []);
    const page2 = makePage(W, H, []);
    const result = applyZoneGrid(makeIssue([cover, page2]));
    expect(result.pages[0].panels).toHaveLength(0);
    expect(result.pages[1].panels).toHaveLength(6);
  });
});

// ─── Reading order: TL → TR → ML → MR → BL → BR ─────────────────────────────

describe("applyZoneGrid — reading order", () => {
  it("zone 0 is top-left: x=0, y=0", () => {
    const zones = zonePage(W, H);
    expect(zones[0]).toMatchObject({ x: 0, y: 0, w: zoneW, h: zoneH });
  });

  it("zone 1 is top-right: x=zoneW, y=0", () => {
    const zones = zonePage(W, H);
    expect(zones[1]).toMatchObject({ x: zoneW, y: 0 });
    expect(zones[1].x + zones[1].w).toBe(W); // absorbs remainder
  });

  it("zone 2 is middle-left: x=0, y=zoneH", () => {
    const zones = zonePage(W, H);
    expect(zones[2]).toMatchObject({ x: 0, y: zoneH, w: zoneW, h: zoneH });
  });

  it("zone 3 is middle-right: x=zoneW, y=zoneH", () => {
    const zones = zonePage(W, H);
    expect(zones[3]).toMatchObject({ x: zoneW, y: zoneH });
  });

  it("zone 4 is bottom-left: x=0, y=zoneH*2", () => {
    const zones = zonePage(W, H);
    expect(zones[4]).toMatchObject({ x: 0, y: zoneH * 2 });
  });

  it("zone 5 is bottom-right: x=zoneW, y=zoneH*2", () => {
    const zones = zonePage(W, H);
    expect(zones[5]).toMatchObject({ x: zoneW, y: zoneH * 2 });
  });
});

// ─── Full coverage (no gaps, no overlap) ─────────────────────────────────────

describe("applyZoneGrid — zones tile the page exactly", () => {
  it("left column zones span x=0 to zoneW", () => {
    const zones = zonePage(W, H);
    for (const zone of [zones[0], zones[2], zones[4]]) {
      expect(zone.x).toBe(0);
      expect(zone.w).toBe(zoneW);
    }
  });

  it("right column zones span zoneW to page.width", () => {
    const zones = zonePage(W, H);
    for (const zone of [zones[1], zones[3], zones[5]]) {
      expect(zone.x).toBe(zoneW);
      expect(zone.x + zone.w).toBe(W);
    }
  });

  it("top row zones span y=0 to zoneH", () => {
    const zones = zonePage(W, H);
    expect(zones[0].y).toBe(0);
    expect(zones[1].y).toBe(0);
    expect(zones[0].h).toBe(zoneH);
    expect(zones[1].h).toBe(zoneH);
  });

  it("bottom row absorbs any height remainder so no gap at page bottom", () => {
    const zones = zonePage(W, H);
    const bottomH = H - zoneH * 2;
    expect(zones[4].h).toBe(bottomH);
    expect(zones[5].h).toBe(bottomH);
    expect(zones[4].y + zones[4].h).toBe(H);
    expect(zones[5].y + zones[5].h).toBe(H);
  });

  it("total area of 6 zones equals page area", () => {
    const zones = zonePage(W, H);
    const total = zones.reduce((sum, z) => sum + z.w * z.h, 0);
    expect(total).toBe(W * H);
  });
});

// ─── Center coordinates ───────────────────────────────────────────────────────

describe("applyZoneGrid — centerX / centerY", () => {
  it("each zone's centerX is within the zone's x bounds", () => {
    const zones = zonePage(W, H);
    for (const z of zones) {
      expect(z.centerX).toBeGreaterThanOrEqual(z.x);
      expect(z.centerX).toBeLessThanOrEqual(z.x + z.w);
    }
  });

  it("each zone's centerY is within the zone's y bounds", () => {
    const zones = zonePage(W, H);
    for (const z of zones) {
      expect(z.centerY).toBeGreaterThanOrEqual(z.y);
      expect(z.centerY).toBeLessThanOrEqual(z.y + z.h);
    }
  });

  it("top-left centerX is halfway across the left half", () => {
    const zones = zonePage(W, H);
    expect(zones[0].centerX).toBe(Math.round(zoneW / 2));
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("applyZoneGrid — edge cases", () => {
  it("page with width=0 passes through with panels: []", () => {
    const cover = makePage(0, H, []);
    const page: PageManifest = { file: "p.jpg", width: 0, height: H, panels: [] };
    const result = applyZoneGrid(makeIssue([cover, page]));
    expect(result.pages[1].panels).toHaveLength(0);
  });

  it("page with height=0 passes through with panels: []", () => {
    const cover = makePage(W, H, []);
    const page: PageManifest = { file: "p.jpg", width: W, height: 0, panels: [] };
    const result = applyZoneGrid(makeIssue([cover, page]));
    expect(result.pages[1].panels).toHaveLength(0);
  });

  it("evenly divisible dimensions produce equal-sized zones", () => {
    const W2 = 1200, H2 = 1800;
    const cover = makePage(W2, H2, []);
    const page  = makePage(W2, H2, []);
    const result = applyZoneGrid(makeIssue([cover, page]));
    const zones = result.pages[1].panels;
    expect(zones[0].w).toBe(600);
    expect(zones[0].h).toBe(600);
    expect(zones[5].w).toBe(600); // no remainder
    expect(zones[5].h).toBe(600); // no remainder
  });
});

// ─── Montage / degenerate-layout handling ─────────────────────────────────────

function beat(x: number, y: number, w: number, h: number, kind: FocusRegion["kind"] = "balloon"): FocusRegion {
  return { x, y, w, h, centerX: x + Math.round(w / 2), centerY: y + Math.round(h / 2), kind };
}
function panelWithBeats(x: number, y: number, w: number, h: number, beats: FocusRegion[]): Panel {
  return { ...makePanel(x, y, w, h), beats };
}

describe("isDegeneratePage", () => {
  const PW = 1171, PH = 1799;

  it("flags a page where a full-height ribbon sits beside much shorter panels (page-7 shape)", () => {
    const page = makePage(PW, PH, [
      makePanel(0, 0, 544, 711),       // short left block
      makePanel(544, 0, 344, PH),      // full-height ribbon
      makePanel(944, 0, 227, PH),      // full-height ribbon
      makePanel(0, 711, 544, 671),     // short
      makePanel(0, 1382, 544, 417),    // short
    ]);
    expect(isDegeneratePage(page)).toBe(true);
  });

  it("does NOT flag a clean uniform 3-column layout (all full-height)", () => {
    const page = makePage(PW, PH, [
      makePanel(0, 0, 390, PH),
      makePanel(390, 0, 390, PH),
      makePanel(780, 0, 391, PH),
    ]);
    expect(isDegeneratePage(page)).toBe(false);
  });

  it("does NOT flag a banner-over-grid layout (no full-height ribbon)", () => {
    const page = makePage(PW, PH, [
      makePanel(0, 0, PW, 500),         // wide banner
      makePanel(0, 500, 585, 1299),     // ~0.72H
      makePanel(586, 500, 585, 1299),
    ]);
    expect(isDegeneratePage(page)).toBe(false);
  });

  it("does NOT flag pages with fewer than 3 panels", () => {
    const page = makePage(PW, PH, [makePanel(0, 0, 585, PH), makePanel(586, 0, 585, 600)]);
    expect(isDegeneratePage(page)).toBe(false);
  });
});

describe("montagePage", () => {
  const PW = 1171, PH = 1799;

  it("collapses panels to one page-sized panel and flattens beats into reading order", () => {
    const page = makePage(PW, PH, [
      panelWithBeats(544, 0, 344, PH, [
        beat(562, 1232, 326, 90),  // middle row, center column
        beat(562, 981, 326, 90),   // upper row, center column
      ]),
      panelWithBeats(0, 0, 544, 711, [
        beat(331, 78, 133, 56),    // top row, left
      ]),
    ]);
    const m = montagePage(page);
    expect(m.montage).toBe(true);
    expect(m.panels).toHaveLength(1);
    const p = m.panels[0];
    expect(p).toMatchObject({ x: 0, y: 0, w: PW, h: PH });
    // Reading order: top row first, then the two center-column beats by y.
    expect(p.beats!.map((b) => b.y)).toEqual([78, 981, 1232]);
  });

  it("reads a multi-column grid row left-to-right, keeping stacked balloons together", () => {
    // Two grid rows of three columns. The detected beats arrive out of order;
    // vertically-overlapping beats must group into one reading row and sort
    // left-to-right, even when a tall balloon starts slightly lower.
    const page = makePage(PW, PH, [
      panelWithBeats(0, 0, PW, PH, [
        beat(945, 971, 194, 88),   // row A, right col, top balloon
        beat(83, 1021, 159, 84),   // row A, left col
        beat(562, 980, 326, 90),   // row A, middle col, top balloon
        beat(945, 1079, 194, 142), // row A, right col, 2nd balloon (overlaps row A)
        beat(945, 1565, 158, 70),  // row B, right col
        beat(562, 1592, 326, 152), // row B, middle col (taller, starts lower)
      ]),
    ]);
    const xs = montagePage(page).panels[0].beats!.map((b) => b.x);
    expect(xs).toEqual([83, 562, 945, 945, 562, 945]);
  });

  it("keeps a column's stacked dialogue together (no bounce to an adjacent column)", () => {
    // Page-7 row A: middle column has a balloon LOWER than the right column's
    // bottom. A flat row sort reads mid → right → right → back-to-mid; the
    // XY-cut must read each column top-to-bottom, columns left-to-right.
    const page = makePage(PW, PH, [
      panelWithBeats(0, 0, PW, PH, [
        beat(945, 971, 194, 88),   // right col, top
        beat(83, 1021, 159, 83),   // left col, top
        beat(562, 980, 326, 89),   // middle col, top
        beat(945, 1079, 194, 142), // right col, bottom
        beat(251, 1021, 242, 83),  // left col, 2nd (same row as left top)
        beat(562, 1232, 326, 89),  // middle col, bottom (lower than right col)
      ]),
    ]);
    const xs = montagePage(page).panels[0].beats!.map((b) => b.x);
    // left(83,251) → middle(562,562) → right(945,945)
    expect(xs).toEqual([83, 251, 562, 562, 945, 945]);
  });

  it("drops sliver/junk beats below the minimum size", () => {
    const page = makePage(PW, PH, [
      panelWithBeats(0, 0, 544, 711, [
        beat(84, 1021, 159, 84),
        beat(520, 1021, 24, 84), // junk: 24px wide
      ]),
      makePanel(544, 0, 344, PH),
      makePanel(944, 0, 227, PH),
    ]);
    const m = montagePage(page);
    expect(m.panels[0].beats).toHaveLength(1);
    expect(m.panels[0].beats![0].w).toBe(159);
  });

  it("becomes a pure splash (no panels) when there are no usable beats", () => {
    const page = makePage(PW, PH, [
      makePanel(0, 0, 544, 711),
      makePanel(544, 0, 344, PH),
      makePanel(944, 0, 227, PH),
    ]);
    const m = montagePage(page);
    expect(m.montage).toBe(true);
    expect(m.panels).toHaveLength(0);
  });
});

describe("normalizeMontagePages", () => {
  const PW = 1171, PH = 1799;

  it("never touches the cover, normalizes degenerate interior pages only", () => {
    const cover = makePage(PW, PH, []);
    const degenerate = makePage(PW, PH, [
      panelWithBeats(0, 0, 544, 711, [beat(331, 78, 133, 56)]),
      makePanel(544, 0, 344, PH),
      makePanel(944, 0, 227, PH),
      makePanel(0, 711, 544, 671),
    ]);
    const clean = makePage(PW, PH, [makePanel(0, 0, 585, PH), makePanel(586, 0, 585, PH)]);
    const result = normalizeMontagePages(makeIssue([cover, degenerate, clean]));
    expect(result.pages[0].montage).toBeUndefined();
    expect(result.pages[1].montage).toBe(true);
    expect(result.pages[1].panels).toHaveLength(1);
    expect(result.pages[2].montage).toBeUndefined();
    expect(result.pages[2].panels).toHaveLength(2);
  });
});


