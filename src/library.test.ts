import { describe, expect, it } from "vitest";
import type { IssueManifest, PageManifest, Panel } from "./types";
import { expandWidePanels } from "./library";

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

// Run expandWidePanels on a single page and return the resulting panels.
function expandPage(width: number, height: number, panels: Panel[]): Panel[] {
  const result = expandWidePanels(makeIssue([makePage(width, height, panels)]));
  return result.pages[0].panels;
}

// ─── Constants used by several tests ─────────────────────────────────────────
const W = 1156;
const H = 1800;
const halfW = Math.round(W / 2); // 578

// ─── Single standalone panels ─────────────────────────────────────────────────

describe("standalone narrow panel", () => {
  it("emits 1 snap unchanged", () => {
    // 50% of page width — clearly below the 85% threshold
    const panel = makePanel(200, 100, Math.round(W * 0.5), 400);
    const out = expandPage(W, H, [panel]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(panel);
  });
});

describe("standalone wide panel (≥85% of page width)", () => {
  it("emits 2 snaps: left half + right half (no overview)", () => {
    const panel = makePanel(50, 100, Math.round(W * 0.9), 400);
    const out = expandPage(W, H, [panel]);
    expect(out).toHaveLength(2);
  });

  it("snap 0 is left half: x=0, w=halfW", () => {
    const panel = makePanel(50, 100, Math.round(W * 0.9), 400);
    const out = expandPage(W, H, [panel]);
    expect(out[0]).toMatchObject({ x: 0, y: 100, w: halfW, h: 400 });
    expect(out[0].centerX).toBe(Math.round(halfW / 2));
  });

  it("snap 1 is right half: x=halfW, w=W-halfW", () => {
    const panel = makePanel(50, 100, Math.round(W * 0.9), 400);
    const out = expandPage(W, H, [panel]);
    expect(out[1]).toMatchObject({ x: halfW, y: 100, w: W - halfW, h: 400 });
    expect(out[1].centerX).toBe(Math.round(halfW + (W - halfW) / 2));
  });

  it("both snaps share the same y, h, and centerY as the source panel", () => {
    const panel = makePanel(50, 300, Math.round(W * 0.88), 500);
    const out = expandPage(W, H, [panel]);
    for (const snap of out) {
      expect(snap.y).toBe(300);
      expect(snap.h).toBe(500);
      expect(snap.centerY).toBe(panel.centerY);
    }
  });

  it("exactly at 85% threshold counts as wide", () => {
    const panel = makePanel(0, 0, Math.round(W * 0.85), 400);
    const out = expandPage(W, H, [panel]);
    expect(out).toHaveLength(2);
  });

  it("just below 85% threshold (84.9%) counts as narrow", () => {
    const panel = makePanel(0, 0, Math.floor(W * 0.849), 400);
    const out = expandPage(W, H, [panel]);
    expect(out).toHaveLength(1);
  });
});

// ─── Multi-panel rows (sub-panels sharing the same y) ────────────────────────

describe("row with 2 sub-panels", () => {
  it("emits exactly 2 snaps (left half + right half, no overview)", () => {
    const panels = [
      makePanel(192, 20, 690, 455), // row overview / bounding box
      makePanel(192, 20, 374, 455), // left sub-panel
      makePanel(566, 20, 316, 455), // right sub-panel
    ];
    const out = expandPage(W, H, panels);
    expect(out).toHaveLength(2);
  });

  it("sub-panels are consumed and not emitted as standalone snaps", () => {
    const panels = [
      makePanel(192, 20, 690, 455),
      makePanel(192, 20, 374, 455),
      makePanel(566, 20, 316, 455),
    ];
    const out = expandPage(W, H, panels);
    // None of the output snaps should be the raw sub-panel boxes
    for (const snap of out) {
      expect(snap.w).not.toBe(374);
      expect(snap.w).not.toBe(316);
    }
  });

  it("emits page-width left and right halves", () => {
    const panels = [
      makePanel(192, 20, 690, 455),
      makePanel(192, 20, 374, 455),
      makePanel(566, 20, 316, 455),
    ];
    const out = expandPage(W, H, panels);
    expect(out[0]).toMatchObject({ x: 0, y: 20, w: halfW, h: 455 });
    expect(out[1]).toMatchObject({ x: halfW, y: 20, w: W - halfW, h: 455 });
  });
});

describe("row with 3 sub-panels", () => {
  it("still emits exactly 2 snaps (L + R only)", () => {
    const panels = [
      makePanel(34, 501, 1081, 549),  // overview
      makePanel(34, 501,  302, 549),  // sub 1
      makePanel(336, 501, 316, 549),  // sub 2
      makePanel(652, 501, 463, 549),  // sub 3
    ];
    const out = expandPage(W, H, panels);
    expect(out).toHaveLength(2);
  });
});

describe("y-tolerance grouping (harvester jitter)", () => {
  it("panels within 5px y still group into one row (page 10 scenario)", () => {
    // Reproduces the page-10 case: overview+sub1 at y=25, sub2+sub3 at y=27
    const panels = [
      makePanel(54,  25, 1054, 901), // overview,  y=25
      makePanel(54,  25,  413, 897), // sub 1,     y=25
      makePanel(487, 27,  236, 899), // sub 2,     y=27 (2px jitter)
      makePanel(723, 27,  385, 899), // sub 3,     y=27 (2px jitter)
    ];
    const out = expandPage(W, H, panels);
    // Should be ONE row → 2 snaps, not TWO rows → 4 snaps
    expect(out).toHaveLength(2);
  });

  it("panels exactly 5px apart still group together", () => {
    const panels = [
      makePanel(0, 100, Math.round(W * 0.9), 400), // overview y=100
      makePanel(0, 105, Math.round(W * 0.4), 400), // sub,      y=105 (±5)
    ];
    const out = expandPage(W, H, panels);
    expect(out).toHaveLength(2);
  });

  it("panels 6px apart split into separate rows", () => {
    const panels = [
      makePanel(0, 100, Math.round(W * 0.9), 400), // overview y=100, isWide → 2 snaps
      makePanel(0, 106, Math.round(W * 0.4), 400), // second panel y=106, narrow → 1 snap
    ];
    const out = expandPage(W, H, panels);
    expect(out).toHaveLength(3); // 2 (first wide) + 1 (second narrow)
  });
});

// ─── Page 7 reproduction (3 rows × 2 snaps = 6 total) ────────────────────────

describe("page 7 of tales-from-the-crypt (3 multi-panel rows)", () => {
  const page7Panels: Panel[] = [
    // Row 1: overview + 2 sub-panels
    { x: 192, y: 20,   w: 690,  h: 455, centerX: 537, centerY: 247 },
    { x: 192, y: 20,   w: 374,  h: 455, centerX: 379, centerY: 247 },
    { x: 566, y: 20,   w: 316,  h: 455, centerX: 724, centerY: 247 },
    // Row 2: overview + 3 sub-panels
    { x: 34,  y: 501,  w: 1081, h: 549, centerX: 574, centerY: 775 },
    { x: 34,  y: 501,  w: 302,  h: 549, centerX: 185, centerY: 775 },
    { x: 336, y: 501,  w: 316,  h: 549, centerX: 494, centerY: 775 },
    { x: 652, y: 501,  w: 463,  h: 549, centerX: 883, centerY: 775 },
    // Row 3: overview + 2 sub-panels
    { x: 34,  y: 1075, w: 939,  h: 670, centerX: 503, centerY: 1410 },
    { x: 34,  y: 1075, w: 524,  h: 670, centerX: 296, centerY: 1410 },
    { x: 720, y: 1075, w: 253,  h: 670, centerX: 846, centerY: 1410 },
  ];

  it("produces exactly 6 snaps (3 rows × 2)", () => {
    const out = expandPage(W, H, page7Panels);
    expect(out).toHaveLength(6);
  });

  it("snap 0 is row-1 left half", () => {
    const out = expandPage(W, H, page7Panels);
    expect(out[0]).toMatchObject({ x: 0, y: 20, w: halfW, h: 455 });
  });

  it("snap 1 is row-1 right half", () => {
    const out = expandPage(W, H, page7Panels);
    expect(out[1]).toMatchObject({ x: halfW, y: 20, w: W - halfW, h: 455 });
  });

  it("snap 2 is row-2 left half", () => {
    const out = expandPage(W, H, page7Panels);
    expect(out[2]).toMatchObject({ x: 0, y: 501, w: halfW, h: 549 });
  });

  it("snap 4 is row-3 left half", () => {
    const out = expandPage(W, H, page7Panels);
    expect(out[4]).toMatchObject({ x: 0, y: 1075, w: halfW, h: 670 });
  });

  it("halves share the same y/h/centerY within each row", () => {
    const out = expandPage(W, H, page7Panels);
    // Row 1: snaps 0,1
    expect(out[0].y).toBe(out[1].y);
    expect(out[0].h).toBe(out[1].h);
    expect(out[0].centerY).toBe(out[1].centerY);
    // Row 2: snaps 2,3
    expect(out[2].y).toBe(out[3].y);
    expect(out[2].h).toBe(out[3].h);
    // Row 3: snaps 4,5
    expect(out[4].y).toBe(out[5].y);
    expect(out[4].h).toBe(out[5].h);
  });
});

// ─── Mixed page: some wide rows, some narrow panels ──────────────────────────

describe("mixed page (wide rows + narrow panels)", () => {
  it("counts correctly: 2 + 1 + 2 = 5 snaps", () => {
    const W2 = 1000;
    const panels = [
      // Row 1 with sub-panels (2 panels at y=0)
      makePanel(0, 0, 700, 300),
      makePanel(0, 0, 400, 300),
      makePanel(400, 0, 300, 300),
      // Single narrow panel (y=350)
      makePanel(100, 350, 400, 200),  // 40% of page width → narrow
      // Single wide standalone panel (y=600)
      makePanel(0, 600, Math.round(W2 * 0.9), 400),
    ];
    const out = expandPage(W2, 1200, panels);
    expect(out).toHaveLength(5); // 2 (wide row) + 1 (narrow) + 2 (wide)
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("page with no panels passes through unchanged", () => {
    const result = expandWidePanels(makeIssue([makePage(W, H, [])]));
    expect(result.pages[0].panels).toHaveLength(0);
  });

  it("page with missing width passes through unchanged", () => {
    const page: PageManifest = { file: "page.jpg", width: 0, height: H, panels: [makePanel(0, 0, 100, 100)] };
    const result = expandWidePanels(makeIssue([page]));
    expect(result.pages[0].panels).toHaveLength(1);
    expect(result.pages[0].panels[0]).toEqual(page.panels[0]);
  });

  it("left-half centerX is halfway across the left half", () => {
    const panel = makePanel(0, 0, W, H);
    const out = expandPage(W, H, [panel]);
    expect(out[0].centerX).toBe(Math.round(halfW / 2));
  });

  it("right-half centerX is halfway across the right half", () => {
    const panel = makePanel(0, 0, W, H);
    const out = expandPage(W, H, [panel]);
    expect(out[1].centerX).toBe(Math.round(halfW + (W - halfW) / 2));
  });
});
