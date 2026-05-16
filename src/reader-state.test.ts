import { describe, expect, it } from "vitest";
import type { IssueManifest } from "./types";
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

describe("snap-loop", () => {
  it("starts at the cover", () => {
    expect(initialPosition()).toEqual({ pageIndex: 0, panelIndex: -1 });
    expect(isCover(initialPosition())).toBe(true);
  });

  it("full-page → next page (when no panels)", () => {
    const issue = makeIssue([0, 0]); // two pages, no panels
    const n = nextPosition({ pageIndex: 0, panelIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: -1 });
  });

  it("full-page → first panel (when page has panels)", () => {
    const issue = makeIssue([0, 3]);
    const n = nextPosition({ pageIndex: 1, panelIndex: -1 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 0 });
  });

  it("panel → next panel", () => {
    const issue = makeIssue([0, 3]);
    const n = nextPosition({ pageIndex: 1, panelIndex: 0 }, issue);
    expect(n).toEqual({ pageIndex: 1, panelIndex: 1 });
  });

  it("last panel → next page full view", () => {
    const issue = makeIssue([0, 3, 0]);
    const n = nextPosition({ pageIndex: 1, panelIndex: 2 }, issue);
    expect(n).toEqual({ pageIndex: 2, panelIndex: -1 });
  });

  it("returns null at end of issue", () => {
    const issue = makeIssue([2]);
    const n = nextPosition({ pageIndex: 0, panelIndex: 1 }, issue);
    expect(n).toBeNull();
  });

  it("prev from panel 0 returns to full-page", () => {
    const issue = makeIssue([3]);
    const p = prevPosition({ pageIndex: 0, panelIndex: 0 }, issue);
    expect(p).toEqual({ pageIndex: 0, panelIndex: -1 });
  });

  it("prev from full-page goes to previous page's last panel", () => {
    const issue = makeIssue([3, 0]);
    const p = prevPosition({ pageIndex: 1, panelIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 0, panelIndex: 2 });
  });

  it("prev from full-page when previous has no panels", () => {
    const issue = makeIssue([0, 0]);
    const p = prevPosition({ pageIndex: 1, panelIndex: -1 }, issue);
    expect(p).toEqual({ pageIndex: 0, panelIndex: -1 });
  });

  it("returns null before cover", () => {
    const issue = makeIssue([0]);
    expect(prevPosition({ pageIndex: 0, panelIndex: -1 }, issue)).toBeNull();
  });

  it("serialize / deserialize round-trip", () => {
    expect(deserialize(serialize({ pageIndex: 4, panelIndex: 2 }))).toEqual({
      pageIndex: 4,
      panelIndex: 2,
    });
    expect(deserialize(null)).toEqual(initialPosition());
    expect(deserialize("garbage")).toEqual(initialPosition());
  });
});
