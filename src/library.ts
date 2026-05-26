// Library fetch helpers — static /comics/ manifest tree served from GitHub Pages.
import type { IssueIndexEntry, IssueManifest, Library, PageManifest, Panel, SeriesIndex } from "./types";

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
  return fetchJson<Library>(`${COMICS_BASE}library.json`);
}

export async function fetchSeries(seriesPath: string): Promise<SeriesIndex> {
  return fetchJson<SeriesIndex>(`${COMICS_BASE}${seriesPath}/series.json`);
}

/**
 * Replace all panel data with a fixed 2-column × 3-row zone grid:
 *   TL → TR → ML → MR → BL → BR
 *
 * Every non-cover page gets exactly 6 snaps, regardless of what the
 * harvester detected.  The cover (index 0) always stays panels: [] so
 * it is shown as a full-page splash.
 *
 * Because the zones are computed from page dimensions, the harvester's
 * issue.json panel data is loaded but ignored by the reader.
 */
const ZONE_COLS = 2;
const ZONE_ROWS = 3;

export function applyZoneGrid(manifest: IssueManifest): IssueManifest {
  const pages = manifest.pages.map((page, idx) => {
    // Cover is always a full-page splash — no zone snaps.
    if (idx === 0 || !page.width || !page.height) return { ...page, panels: [] };

    const zoneW = Math.floor(page.width  / ZONE_COLS);
    const zoneH = Math.floor(page.height / ZONE_ROWS);
    const panels: Panel[] = [];

    for (let row = 0; row < ZONE_ROWS; row++) {
      for (let col = 0; col < ZONE_COLS; col++) {
        const x = col * zoneW;
        const y = row * zoneH;
        // Last column / row absorbs any remainder so there's no gap.
        const w = col === ZONE_COLS - 1 ? page.width  - x : zoneW;
        const h = row === ZONE_ROWS - 1 ? page.height - y : zoneH;
        panels.push({
          x,
          y,
          w,
          h,
          centerX: x + Math.round(w / 2),
          centerY: y + Math.round(h / 2),
        });
      }
    }

    return { ...page, panels };
  });
  return { ...manifest, pages };
}

export async function fetchIssue(issuePath: string, _issue?: IssueIndexEntry): Promise<IssueManifest> {
  return fetchJson<IssueManifest>(`${COMICS_BASE}${issuePath}/issue.json`);
}

/** URL for a page image — static path. */
export function pageUrl(issuePath: string, fileOrPage: string | PageManifest): string {
  if (typeof fileOrPage !== "string" && fileOrPage.url) return fileOrPage.url;
  const file = typeof fileOrPage === "string" ? fileOrPage : fileOrPage.file;
  return `${COMICS_BASE}${issuePath}/${file}`;
}

/** URL for a cover thumbnail — static path. */
export function coverUrl(basePath: string, file: string, _fileId?: string, r2Url?: string): string {
  if (r2Url) return r2Url;
  return basePath ? `${COMICS_BASE}${basePath}/${file}` : `${COMICS_BASE}${file}`;
}
