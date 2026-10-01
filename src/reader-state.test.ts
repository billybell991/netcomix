import { describe, expect, it } from "vitest";
import type { IssueManifest, FocusRegion } from "./types";
import {
  deserialize,
  initialPosition,
  isCover,
  nextPosition,
  prevPosition,
  serialize,
} from "./reader-state";

function makeIssue(panelCounts: number[]): IssueManifest {
  return {
    id: "test",
    title: "Test",
    series: "test",
    cover: "page-001.jpg",
    pages: panelCounts.map((n, i) => ({
      file: `page-${i + 1}.jpg`,
      width: 800,
      height: 1200,
      panels: Array.from({ length: n }, (_, j) => ({
        x: j * 10, y: 0, w: 100, h: 100, centerX: j * 10 + 50, centerY: 50,
      })),
    })),
  };
}

function beat(i: number): FocusRegion {
  return { x: i * 10, y: 0, w: 30, h: 20, centerX: i * 10 + 15, centerY: 10, kind: "balloon" };
}

/** One page (index 1) with a single panel that has `beatCount` beats. Page 0 is a bare cover. */
function makeBeatIssue(beatCount: number): IssueManifest {
  return {
    id: "test",
    title: "Test",
    series: "test",
    cover: "page-001.jpg",
    pages: [
      { file: "page-1.jpg", width: 800, height: 1200, panels: [] },
      {
        file: "page-2.jpg",
        width: 800,
        height: 1200,
        panels: [
          { x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50, beats: Array.from({ length: beatCount }, (_, i) => beat(i)) },
          { x: 200, y: 0, w: 100, h: 100, centerX: 250, centerY: 50 },
        ],
      },
      { file: "page-3.jpg", width: 800, height: 1200, panels: [] },
    ],
  };
}

describe("snap-loop", () => {
  it("starts at the cover", () => {
    expect(initialPosition()).toEqual({ pageIndex: 0, panelIndex: -1, beatIndex: -1 });
    expect(isCover(initialPosition())).toBe(true);
  });

  it("full-page → next page (when no panels)", () => {
    const issue = makeIssue([0, 0]); // two pages, no panels
    const n = nextPosition({ pageIndex: 0, panelIndex: -1, beatIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: -1, beatIndex: -1 });
  });

  it("full-page → first panel (when page has panels)", () => {
    const issue = makeIssue([0, 3]);
    const n = nextPosition({ pageIndex: 1, panelIndex: -1, beatIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: -1 });
  });

  it("panel → next panel", () => {
    const issue = makeIssue([0, 3]);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0, beatIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 1, beatIndex: -1 });
  });

  it("last panel → next page full view", () => {
    const issue = makeIssue([0, 3, 0]);
    const n = nextPosition({ pageIndex: 1, panelIndex: 2, beatIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 2, panelIndex: -1, beatIndex: -1 });
  });

  it("returns null at end of issue", () => {
    const issue = makeIssue([2]);
    const n = nextPosition({ pageIndex: 0, panelIndex: 1, beatIndex: -1 }, issue);
    expect(n).toBeNull();
  });

  it("prev from panel 0 returns to full-page", () => {
    const issue = makeIssue([3]);
    const p = prevPosition({ pageIndex: 0, panelIndex: 0, beatIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 0, panelIndex: -1, beatIndex: -1 });
  });

  it("prev from full-page goes to previous page's last panel", () => {
    const issue = makeIssue([0, 3, 0]);
    const p = prevPosition({ pageIndex: 2, panelIndex: -1, beatIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 1, panelIndex: 2, beatIndex: -1 });
  });

  it("prev from full-page when previous has no panels", () => {
    const issue = makeIssue([0, 0]);
    const p = prevPosition({ pageIndex: 1, panelIndex: -1, beatIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 0, panelIndex: -1, beatIndex: -1 });
  });

  it("returns null before cover", () => {
    const issue = makeIssue([0]);
    expect(prevPosition({ pageIndex: 0, panelIndex: -1, beatIndex: -1 }, issue)).toBeNull();
  });

  it("serialize / deserialize round-trip", () => {
    expect(deserialize(serialize({ pageIndex: 4, panelIndex: 2, beatIndex: 1 }))).toEqual({
      pageIndex: 4,
      panelIndex: 2,
      beatIndex: 1,
    });
    expect(deserialize(null)).toEqual(initialPosition());
    expect(deserialize("garbage")).toEqual(initialPosition());
  });

  it("deserializes legacy page:panel progress (no beat segment)", () => {
    expect(deserialize("4:2")).toEqual({ pageIndex: 4, panelIndex: 2, beatIndex: -1 });
  });
});

describe("beat snapping", () => {
  it("whole panel with beats → first beat", () => {
    const issue = makeBeatIssue(2);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0, beatIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: 0 });
  });

  it("beat → next beat", () => {
    const issue = makeBeatIssue(3);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0, beatIndex: 0 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: 1 });
  });

  it("last beat of a panel → next panel (whole)", () => {
    const issue = makeBeatIssue(2);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0, beatIndex: 1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 1, beatIndex: -1 });
  });

  it("useBeats=false skips beats entirely (panel → next panel)", () => {
    const issue = makeBeatIssue(3);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0, beatIndex: -1 }, issue, false);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 1, beatIndex: -1 });
  });

  it("prev from first beat → whole panel", () => {
    const issue = makeBeatIssue(2);
    const p = prevPosition({ pageIndex: 1, panelIndex: 0, beatIndex: 0 }, issue);
    expect(p).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: -1 });
  });

  it("prev from beat 1 → beat 0", () => {
    const issue = makeBeatIssue(3);
    const p = prevPosition({ pageIndex: 1, panelIndex: 0, beatIndex: 1 }, issue);
    expect(p).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: 0 });
  });

  it("prev from whole panel 1 → previous panel's last beat", () => {
    const issue = makeBeatIssue(2);
    const p = prevPosition({ pageIndex: 1, panelIndex: 1, beatIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 1, panelIndex: 0, beatIndex: 1 });
  });

  it("forward walk visits page → panel → each beat → next panel", () => {
    const issue = makeBeatIssue(2);
    const seq: string[] = [];
    let pos: ReturnType<typeof nextPosition> = { pageIndex: 0, panelIndex: -1, beatIndex: -1 };
    for (let i = 0; i < 8 && pos; i++) {
      seq.push(serialize(pos));
      pos = nextPosition(pos, issue);
    }
    expect(seq).toEqual([
      "0:-1:-1", // cover
      "1:-1:-1", // page 1 full
      "1:0:-1",  // panel 0 whole
      "1:0:0",   // panel 0 beat 0
      "1:0:1",   // panel 0 beat 1
      "1:1:-1",  // panel 1 whole (no beats)
      "2:-1:-1", // page 2 full
    ]);
  });
});

describe("snap-loop — montage pages", () => {
  /** Page 1 is a montage: a single page-sized panel with `beatCount` flattened beats. */
  function makeMontageIssue(beatCount: number): IssueManifest {
    return {
      id: "test",
      title: "Test",
      series: "test",
      cover: "page-001.jpg",
      pages: [
        { file: "page-1.jpg", width: 800, height: 1200, panels: [] },
        {
          file: "page-2.jpg",
          width: 800,
          height: 1200,
          montage: true,
          panels: [
            { x: 0, y: 0, w: 800, h: 1200, centerX: 400, centerY: 600, beats: Array.from({ length: beatCount }, (_, i) => beat(i)) },
          ],
        },
        { file: "page-3.jpg", width: 800, height: 1200, panels: [] },
      ],
    };
  }

  it("skips the whole-panel view: full page → straight into beats → next page", () => {
    const issue = makeMontageIssue(3);
    const seq: string[] = [];
    let pos: ReturnType<typeof nextPosition> = { pageIndex: 1, panelIndex: -1, beatIndex: -1 };
    for (let i = 0; i < 8 && pos; i++) {
      seq.push(serialize(pos));
      pos = nextPosition(pos, issue);
    }
    expect(seq).toEqual([
      "1:-1:-1", // montage page, full view
      "1:0:0",   // first beat (no redundant "1:0:-1" whole-panel step)
      "1:0:1",
      "1:0:2",
      "2:-1:-1", // next page full
    ]);
  });

  it("going back from the first beat returns to the full page, not the whole panel", () => {
    const issue = makeMontageIssue(3);
    const back = prevPosition({ pageIndex: 1, panelIndex: 0, beatIndex: 0 }, issue);
    expect(back).toEqual({ pageIndex: 1, panelIndex: -1, beatIndex: -1 });
  });

  it("is a clean round-trip: forward then backward retraces the same stops", () => {
    const issue = makeMontageIssue(2);
    const forward: string[] = [];
    let pos: ReturnType<typeof nextPosition> = { pageIndex: 1, panelIndex: -1, beatIndex: -1 };
    while (pos && pos.pageIndex < 2) {
      forward.push(serialize(pos));
      pos = nextPosition(pos, issue);
    }
    const backward: string[] = [];
    let b: ReturnType<typeof prevPosition> = { pageIndex: 1, panelIndex: 0, beatIndex: 1 };
    while (b && !(b.pageIndex === 1 && b.panelIndex === -1)) {
      backward.push(serialize(b));
      b = prevPosition(b, issue);
    }
    backward.push("1:-1:-1");
    expect(backward.reverse()).toEqual(forward);
  });
});
