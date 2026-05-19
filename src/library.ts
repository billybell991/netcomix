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
 * For wide panels (≥85% page width) or any row-overview whose sub-panels have
 * suspicious gaps (>30 px, indicating a _split_at_borders false split on dark
 * artwork), insert two virtual 50/50 sub-snaps after the overview snap.
 * No DB changes required — expansion is applied at read-time.
 */
const WIDE_PANEL_RATIO = 0.85;
const SUB_GAP_THRESHOLD = 30; // px gap between adjacent sub-panels = false split

function expandWidePanels(manifest: IssueManifest): IssueManifest {
  const pages = manifest.pages.map((page) => {
    if (!page.width || page.panels.length === 0) return page;
    const expanded: Panel[] = [];
    for (let i = 0; i < page.panels.length; i++) {
      const panel = page.panels[i];
      expanded.push(panel);

      // Count stored sub-panels that share the same y (row-overview pattern).
      let subCount = 0;
      while (i + 1 + subCount < page.panels.length && page.panels[i + 1 + subCount].y === panel.y) {
        subCount++;
      }
      if (subCount === 0) continue; // standalone panel — nothing to do

      const isWide = panel.w / page.width >= WIDE_PANEL_RATIO;
      const subPanels = page.panels.slice(i + 1, i + 1 + subCount);
      // Detect false splits: a gap between consecutive sub-panels means
      // _split_at_borders mis-fired on dark artwork.
      const hasGaps = subPanels.some(
        (sp, k) => k > 0 && sp.x - (subPanels[k - 1].x + subPanels[k - 1].w) > SUB_GAP_THRESHOLD,
      );

      if (!isWide && !hasGaps) {
        // Correctly-detected sub-panels on a non-wide row — emit naturally.
        continue;
      }
      if (subCount >= 3 && !hasGaps) {
        // Wide panel with 3+ correctly-spaced sub-panels — emit naturally.
        continue;
      }

      // Use clean 50/50 virtual halves of the overview instead of the stored
      // sub-panels (which may be skewed, narrow, or have gaps).
      const halfW = Math.round(panel.w / 2);
      expanded.push(
        {
          x: panel.x,
          y: panel.y,
          w: halfW,
          h: panel.h,
          centerX: Math.round(panel.x + halfW / 2),
          centerY: panel.centerY,
        },
        {
          x: panel.x + halfW,
          y: panel.y,
          w: halfW,
          h: panel.h,
          centerX: Math.round(panel.x + halfW + halfW / 2),
          centerY: panel.centerY,
        },
      );
      // Skip the stored sub-panels — virtual halves replace them.
      i += subCount;
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
