// The "Snap Loop" state machine — pure functions, fully testable.
// Three nesting levels:
//   full page (panelIndex -1)
//     → panel as a whole (panelIndex N, beatIndex -1)
//       → text beat inside the panel (panelIndex N, beatIndex M)
// Forward/back navigate through pages, their panels, and (when present) each
// panel's text beats — mimicking how a human reads: see the panel, then look
// into each balloon/caption in turn.

import type { IssueManifest, Panel } from "./types";

export interface ReaderPosition {
  pageIndex: number;
  /** -1 means "full page view"; 0..n-1 means panel index */
  panelIndex: number;
  /** -1 means "whole panel"; 0..n-1 means text-beat index within the panel */
  beatIndex: number;
}

export function initialPosition(): ReaderPosition {
  return { pageIndex: 0, panelIndex: -1, beatIndex: -1 };
}

function beatsOf(panel: Panel | undefined, useBeats: boolean): number {
  return useBeats && panel?.beats ? panel.beats.length : 0;
}

/**
 * Advance one step. Returns null if we're past the end of the issue.
 * Logic:
 *   - From full-page: if the page has panels, snap to first panel (whole); else next page full.
 *   - From a whole panel with beats: snap to its first beat.
 *   - From beat M: go to beat M+1; if past last beat, next panel (whole).
 *   - From last panel (and its last beat): next page full.
 */
export function nextPosition(
  pos: ReaderPosition,
  issue: IssueManifest,
  useBeats = true,
): ReaderPosition | null {
  const page = issue.pages[pos.pageIndex];
  if (!page) return null;
  const panels = page.panels;

  const nextPageFull = (): ReaderPosition | null => {
    const np = pos.pageIndex + 1;
    if (np >= issue.pages.length) return null;
    return { pageIndex: np, panelIndex: -1, beatIndex: -1 };
  };

  if (pos.panelIndex === -1) {
    // Cover (page 0) is always a splash — never snap into its panels.
    if (pos.pageIndex > 0 && panels.length > 0) {
      // A montage page collapses to a single page-sized panel, so its
      // "whole panel" view is identical to the full page — skip it and step
      // straight into the first text beat.
      if (page.montage && useBeats && (panels[0]?.beats?.length ?? 0) > 0) {
        return { pageIndex: pos.pageIndex, panelIndex: 0, beatIndex: 0 };
      }
      return { pageIndex: pos.pageIndex, panelIndex: 0, beatIndex: -1 };
    }
    return nextPageFull();
  }

  const panel = panels[pos.panelIndex];
  const beatCount = beatsOf(panel, useBeats);

  // Whole panel with beats → look into the first beat.
  if (pos.beatIndex === -1 && beatCount > 0) {
    return { pageIndex: pos.pageIndex, panelIndex: pos.panelIndex, beatIndex: 0 };
  }
  // Mid-panel → next beat.
  if (pos.beatIndex >= 0 && pos.beatIndex + 1 < beatCount) {
    return { pageIndex: pos.pageIndex, panelIndex: pos.panelIndex, beatIndex: pos.beatIndex + 1 };
  }
  // Done with this panel → next panel (whole).
  const nextPanel = pos.panelIndex + 1;
  if (nextPanel < panels.length) {
    return { pageIndex: pos.pageIndex, panelIndex: nextPanel, beatIndex: -1 };
  }
  return nextPageFull();
}

/**
 * Move back one step. Returns null at start of issue. Exact mirror of nextPosition.
 */
export function prevPosition(
  pos: ReaderPosition,
  issue: IssueManifest,
  useBeats = true,
): ReaderPosition | null {
  const page = issue.pages[pos.pageIndex];
  const panels = page?.panels ?? [];

  if (pos.panelIndex >= 0) {
    // On a beat → previous beat, or back out to the whole panel.
    if (pos.beatIndex > 0) {
      return { pageIndex: pos.pageIndex, panelIndex: pos.panelIndex, beatIndex: pos.beatIndex - 1 };
    }
    if (pos.beatIndex === 0) {
      // On a montage page the whole-panel view is the full page — skip it.
      if (page?.montage) {
        return { pageIndex: pos.pageIndex, panelIndex: -1, beatIndex: -1 };
      }
      return { pageIndex: pos.pageIndex, panelIndex: pos.panelIndex, beatIndex: -1 };
    }
    // Whole panel (beatIndex -1) → previous panel's last beat (or whole).
    if (pos.panelIndex > 0) {
      const prevPanel = pos.panelIndex - 1;
      const pBeats = beatsOf(panels[prevPanel], useBeats);
      return {
        pageIndex: pos.pageIndex,
        panelIndex: prevPanel,
        beatIndex: pBeats > 0 ? pBeats - 1 : -1,
      };
    }
    // First panel whole → full page.
    return { pageIndex: pos.pageIndex, panelIndex: -1, beatIndex: -1 };
  }

  // panelIndex === -1 (full page) → previous page.
  const prevPage = pos.pageIndex - 1;
  if (prevPage < 0) return null;
  const pp = issue.pages[prevPage];
  // Cover (page 0) is always a splash — don't land on its panels when going back.
  if (prevPage > 0 && pp.panels.length > 0) {
    const lastPanel = pp.panels.length - 1;
    const lpBeats = beatsOf(pp.panels[lastPanel], useBeats);
    return {
      pageIndex: prevPage,
      panelIndex: lastPanel,
      beatIndex: lpBeats > 0 ? lpBeats - 1 : -1,
    };
  }
  return { pageIndex: prevPage, panelIndex: -1, beatIndex: -1 };
}

/** Convenience: is this position the cover (page 0, full view)? */
export function isCover(pos: ReaderPosition): boolean {
  return pos.pageIndex === 0 && pos.panelIndex === -1;
}

/** Convenience: serialize/restore for localStorage. Format: "page:panel:beat". */
export function serialize(pos: ReaderPosition): string {
  return `${pos.pageIndex}:${pos.panelIndex}:${pos.beatIndex}`;
}
export function deserialize(s: string | null | undefined): ReaderPosition {
  if (!s) return initialPosition();
  const parts = s.split(":").map(Number);
  const [p, n, b] = parts;
  if (!Number.isFinite(p) || !Number.isFinite(n)) return initialPosition();
  // Backward-compatible with old "page:panel" progress (no beat segment).
  return { pageIndex: p, panelIndex: n, beatIndex: Number.isFinite(b) ? b : -1 };
}
