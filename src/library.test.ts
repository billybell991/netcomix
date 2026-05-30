import { describe, expect, it } from "vitest";
import type { IssueManifest, PageManifest, Panel } from "./types";
import { applyZoneGrid, normalizeIssueManifest } from "./library";

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

describe("normalizeIssueManifest", () => {
  it("removes row overview panels that would re-center backwards within the same row", () => {
    const cover = makePage(W, H, [makePanel(0, 0, W, H)]);
    const rowOverview = makePanel(40, 1180, 1080, 520);
    const leftPanel = makePanel(40, 1180, 240, 520);
    const rightPanel = makePanel(620, 1180, 500, 520);
    const page = makePage(W, H, [
      makePanel(40, 60, 1080, 520),
      rowOverview,
      leftPanel,
      rightPanel,
    ]);

    const result = normalizeIssueManifest(makeIssue([cover, page]));

    expect(result.pages[0].panels).toEqual([]);
    expect(result.pages[1].panels).toEqual([
      makePanel(40, 60, 1080, 520),
      leftPanel,
      rightPanel,
    ]);
  });

  it("keeps ordinary left-to-right rows intact", () => {
    const cover = makePage(W, H, []);
    const leftPanel = makePanel(40, 1180, 240, 520);
    const rightPanel = makePanel(620, 1180, 500, 520);
    const page = makePage(W, H, [rightPanel, leftPanel]);

    const result = normalizeIssueManifest(makeIssue([cover, page]));

    expect(result.pages[1].panels).toEqual([leftPanel, rightPanel]);
  });
});
