// Library fetch helpers — API-backed when configured, Drive-backed when configured,
// static /comics/ fallback otherwise.

import { isApiConfigured, isDriveConfigured } from "./config";
import { apiLibrary, apiSeries, apiIssue } from "./api";
import { fetchJsonById, mediaUrl } from "./drive";
import type { IssueIndexEntry, IssueManifest, Library, PageManifest, Panel, SeriesEntry, SeriesIndex } from "./types";

// ─── Static-mode (kept for local dev / demo fallback) ──────────────────────

export const COMICS_BASE: string = (() => {
  const fromEnv = (import.meta as unknown as { env?: { VITE_COMICS_BASE?: string; BASE_URL?: string } }).env;
  const explicit = fromEnv?.VITE_COMICS_BASE;
  if (explicit) return explicit.replace(/\/+$/, "") + "/";
  const baseUrl = fromEnv?.BASE_URL ?? "/";
  return `${baseUrl.replace(/\/+$/, "")}/comics/`;
})();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

// ─── Public API ────────────────────────────────────────────────────────────
// Manifests (library.json / series.json / issue.json) are always served from
// the static /public/comics/ tree — published by the harvester and committed
// back to the repo. Only the binary page images come from Drive (via fileId),
// which sidesteps Drive's folder-listing limitation for API-key clients.

export async function fetchLibrary(): Promise<Library> {
  if (isApiConfigured()) return apiLibrary();
  return fetchJson<Library>(`${COMICS_BASE}library.json`);
}

export async function fetchSeries(seriesPath: string, _series?: SeriesEntry): Promise<SeriesIndex> {
  if (isApiConfigured()) return apiSeries(seriesPath);
  return fetchJson<SeriesIndex>(`${COMICS_BASE}${seriesPath}/series.json`);
}

/**
 * Post-process panel data from the DB to produce navigation snaps.
 *
 * For each row (overview panel + detected sub-panels sharing the same y):
 *   1. Emit the row overview (full row width) as the first snap.
 *   2. Group sub-panels into a LEFT group (center-x ≤ overview midpoint) and
 *      a RIGHT group (center-x > overview midpoint).
 *   3. Emit a bounding-box panel for the left group and one for the right group.
 *      Using actual sub-panel bounds (not a blind 50/50 split) ensures the
 *      artwork boundaries are respected and no panel content is cut off.
 *
 * For standalone wide panels (≥85% page width, no sub-panels):
 *   Emit virtual 50/50 halves so every wide row still gets overview → L → R.
 *
 * Standalone narrow panels with no sub-panels get a single snap only.
 */
const WIDE_PANEL_RATIO = 0.85;

/** Compute the bounding box of a set of panels. */
function panelBBox(panels: Panel[]): Panel {
  const x = Math.min(...panels.map((p) => p.x));
  const right = Math.max(...panels.map((p) => p.x + p.w));
  const y = Math.min(...panels.map((p) => p.y));
  const bottom = Math.max(...panels.map((p) => p.y + p.h));
  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
    centerX: Math.round((x + right) / 2),
    centerY: Math.round((y + bottom) / 2),
  };
}

function expandWidePanels(manifest: IssueManifest): IssueManifest {
  const pages = manifest.pages.map((page) => {
    if (!page.width || page.panels.length === 0) return page;
    const expanded: Panel[] = [];
    for (let i = 0; i < page.panels.length; i++) {
      const panel = page.panels[i];

      // Collect sub-panels that share the same y (row siblings of this overview).
      const subs: Panel[] = [];
      let j = i + 1;
      while (j < page.panels.length && page.panels[j].y === panel.y) {
        subs.push(page.panels[j]);
        j++;
      }
      const subCount = subs.length;

      const isWide = panel.w / page.width >= WIDE_PANEL_RATIO;

      // Always emit the row overview first.
      expanded.push(panel);

      if (subCount > 0) {
        // Group actual sub-panels into left and right halves using the overview
        // midpoint as the dividing line.  This respects the actual artwork
        // boundaries instead of a blind 50/50 split.
        const mid = panel.x + panel.w / 2;
        const leftSubs = subs.filter((s) => s.x + s.w / 2 <= mid);
        const rightSubs = subs.filter((s) => s.x + s.w / 2 > mid);

        if (leftSubs.length > 0 && rightSubs.length > 0) {
          expanded.push(panelBBox(leftSubs), panelBBox(rightSubs));
        } else {
          // Degenerate: all subs on one side — fall back to virtual halves.
          const halfW = Math.round(panel.w / 2);
          expanded.push(
            { x: panel.x, y: panel.y, w: halfW, h: panel.h, centerX: Math.round(panel.x + halfW / 2), centerY: panel.centerY },
            { x: panel.x + halfW, y: panel.y, w: halfW, h: panel.h, centerX: Math.round(panel.x + halfW + halfW / 2), centerY: panel.centerY },
          );
        }
        i = j - 1; // skip sub-panels — we've already consumed them above
      } else if (isWide) {
        // Standalone wide panel — no sub-panels detected, use virtual 50/50 halves.
        const halfW = Math.round(panel.w / 2);
        expanded.push(
          { x: panel.x, y: panel.y, w: halfW, h: panel.h, centerX: Math.round(panel.x + halfW / 2), centerY: panel.centerY },
          { x: panel.x + halfW, y: panel.y, w: halfW, h: panel.h, centerX: Math.round(panel.x + halfW + halfW / 2), centerY: panel.centerY },
        );
      }
      // else: standalone narrow panel — single snap, no split
    }
    return { ...page, panels: expanded };
  });
  return { ...manifest, pages };
}

export async function fetchIssue(issuePath: string, issue?: IssueIndexEntry): Promise<IssueManifest> {
  if (isApiConfigured()) {
    // issue.id is the bare issue id; issuePath is "series/issue-id"
    const id = issue?.id ?? issuePath.split("/").pop() ?? issuePath;
    return expandWidePanels(await apiIssue(id));
  }
  if (issue?.issueFileId && isDriveConfigured()) {
    return expandWidePanels(await fetchJsonById<IssueManifest>(issue.issueFileId));
  }
  return expandWidePanels(await fetchJson<IssueManifest>(`${COMICS_BASE}${issuePath}/issue.json`));
}

/** URL for a page image — R2 URL (api-mode), drive media URL, or static path. */
export function pageUrl(issuePath: string, fileOrPage: string | PageManifest): string {
  if (typeof fileOrPage !== "string") {
    if (fileOrPage.url) return fileOrPage.url;
    if (fileOrPage.fileId && isDriveConfigured()) return mediaUrl(fileOrPage.fileId);
  }
  const file = typeof fileOrPage === "string" ? fileOrPage : fileOrPage.file;
  return `${COMICS_BASE}${issuePath}/${file}`;
}

/** URL for a cover thumbnail — R2 URL (api-mode), drive media URL, or static path. */
export function coverUrl(basePath: string, file: string, fileId?: string, r2Url?: string): string {
  if (r2Url) return r2Url;
  if (fileId && isDriveConfigured()) return mediaUrl(fileId);
  return `${COMICS_BASE}${basePath}/${file}`;
}
