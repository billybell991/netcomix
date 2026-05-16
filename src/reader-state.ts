// The "Snap Loop" state machine — pure functions, fully testable.
// State A = full page, State B = panel-by-panel. Forward/back navigate
// through pages and (when present) their panels.

import type { IssueManifest } from "./types";

export interface ReaderPosition {
  pageIndex: number;
  /** -1 means "full page view"; 0..n-1 means panel index */
  panelIndex: number;
}

export function initialPosition(): ReaderPosition {
  return { pageIndex: 0, panelIndex: -1 };
}

/**
 * Advance one step. Returns null if we're past the end of the issue.
 * Logic:
 *   - From full-page: if the page has panels, snap to first panel; else next page full.
 *   - From panel N: go to panel N+1; if past last panel, next page full.
 */
export function nextPosition(pos: ReaderPosition, issue: IssueManifest): ReaderPosition | null {
  const page = issue.pages[pos.pageIndex];
  if (!page) return null;

  if (pos.panelIndex === -1) {
    if (page.panels.length > 0) {
      return { pageIndex: pos.pageIndex, panelIndex: 0 };
    }
    const nextPage = pos.pageIndex + 1;
    if (nextPage >= issue.pages.length) return null;
    return { pageIndex: nextPage, panelIndex: -1 };
  }

  const nextPanel = pos.panelIndex + 1;
  if (nextPanel < page.panels.length) {
    return { pageIndex: pos.pageIndex, panelIndex: nextPanel };
  }
  const nextPage = pos.pageIndex + 1;
  if (nextPage >= issue.pages.length) return null;
  return { pageIndex: nextPage, panelIndex: -1 };
}

/**
 * Move back one step. Returns null at start of issue.
 * Going back from full-page: previous page's last panel (or full if no panels).
 * Going back from panel 0: full-page view of same page.
 */
export function prevPosition(pos: ReaderPosition, issue: IssueManifest): ReaderPosition | null {
  if (pos.panelIndex > 0) {
    return { pageIndex: pos.pageIndex, panelIndex: pos.panelIndex - 1 };
  }
  if (pos.panelIndex === 0) {
    return { pageIndex: pos.pageIndex, panelIndex: -1 };
  }
  // panelIndex === -1 (full page)
  const prevPage = pos.pageIndex - 1;
  if (prevPage < 0) return null;
  const page = issue.pages[prevPage];
  if (page.panels.length > 0) {
    return { pageIndex: prevPage, panelIndex: page.panels.length - 1 };
  }
  return { pageIndex: prevPage, panelIndex: -1 };
}

/** Convenience: is this position the cover (page 0, full view)? */
export function isCover(pos: ReaderPosition): boolean {
  return pos.pageIndex === 0 && pos.panelIndex === -1;
}

/** Convenience: serialize/restore for localStorage. */
export function serialize(pos: ReaderPosition): string {
  return `${pos.pageIndex}:${pos.panelIndex}`;
}
export function deserialize(s: string | null | undefined): ReaderPosition {
  if (!s) return initialPosition();
  const [p, n] = s.split(":").map(Number);
  if (!Number.isFinite(p) || !Number.isFinite(n)) return initialPosition();
  return { pageIndex: p, panelIndex: n };
}
