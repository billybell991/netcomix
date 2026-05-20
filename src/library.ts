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
 * For each row-overview panel (and any standalone wide panel):
 *   1. Emit a LEFT half spanning x=0 … page.width/2 for the full row height.
 *   2. Emit a RIGHT half spanning x=page.width/2 … page.width for the full row height.
 *
 * Splitting on page.width (not on the detected panel bounds) ensures the reader
 * always sees the complete left or right half of the page — including artwork
 * in the gutters/margins that sits outside the harvester's detected panel box.
 * It also makes the halves immune to speech-balloon detection noise.
 *
 * Standalone narrow panels with no sub-panels get a single snap only.
 */
const WIDE_PANEL_RATIO = 0.85;
/** Max pixel difference in y to still consider panels part of the same row. */
const PANEL_Y_TOLERANCE = 5;

export function expandWidePanels(manifest: IssueManifest): IssueManifest {
  const pages = manifest.pages.map((page) => {
    if (!page.width || page.panels.length === 0) return page;
    const expanded: Panel[] = [];
    const halfW = Math.round(page.width / 2);
    for (let i = 0; i < page.panels.length; i++) {
      const panel = page.panels[i];

      // Skip over any sub-panels that share the same row — we don't navigate
      // to them individually; we use page-width halves instead.
      // Allow a small y-tolerance so harvester jitter (e.g. y=25 vs y=27)
      // doesn't split the same visual row into two separate groups.
      let j = i + 1;
      while (j < page.panels.length && Math.abs(page.panels[j].y - panel.y) <= PANEL_Y_TOLERANCE) {
        j++;
      }
      const subCount = j - i - 1;
      const isWide = panel.w / page.width >= WIDE_PANEL_RATIO;

      if (subCount > 0 || isWide) {
        // Rows with sub-panels or wide standalone panels: emit a LEFT half and
        // RIGHT half only — no full-row overview.  Using page.width for both
        // snaps keeps their box boundaries flush with the page edges, so no
        // spurious outline line appears inside the halves' views.
        expanded.push(
          { x: 0,     y: panel.y, w: halfW,              h: panel.h, centerX: Math.round(halfW / 2),                        centerY: panel.centerY },
          { x: halfW, y: panel.y, w: page.width - halfW, h: panel.h, centerX: Math.round(halfW + (page.width - halfW) / 2), centerY: panel.centerY },
        );
        i = j - 1; // skip sub-panels — consumed above
      } else {
        // Standalone narrow panel — single snap, no split.
        expanded.push(panel);
      }
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
  return basePath ? `${COMICS_BASE}${basePath}/${file}` : `${COMICS_BASE}${file}`;
}
