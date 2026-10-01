// Library fetch helpers — static /comics/ manifest tree served from GitHub Pages.
import type { IssueIndexEntry, IssueManifest, Library, PageManifest, Panel, SeriesIndex, FocusRegion } from "./types";

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
  const manifest = await fetchJson<IssueManifest>(`${COMICS_BASE}${issuePath}/issue.json`);
  return normalizeMontagePages(manifest);
}

// --- Montage / degenerate-layout handling -------------------------------------
// Some pages (montages, collages) have no clean gutters, so the panel splitter
// carves full-height vertical "ribbons" alongside much shorter panels. Snapping
// to a ribbon shows an unreadable thin strip and the reading order jumps around
// — a hot mess. We detect that inconsistent layout and read the page as a whole
// instead, stepping through its text beats in reading order.

/** Drop beat boxes smaller than this (px) — usually detection slivers/junk. */
const MONTAGE_MIN_BEAT_PX = 28;

/**
 * A page is "degenerate" when the splitter produced an inconsistent layout:
 * at least one (near) full-height panel together with much shorter ones. Clean
 * grids, banners, and uniform column layouts don't trigger this — only the
 * mixed-height carving that montage pages produce.
 */
export function isDegeneratePage(page: PageManifest): boolean {
  const { width: W, height: H, panels } = page;
  if (!W || !H || panels.length < 3) return false;
  const heights = panels.map((p) => p.h);
  const tallest = Math.max(...heights);
  const shortest = Math.min(...heights);
  return tallest >= 0.9 * H && shortest <= 0.5 * H;
}

/** Collapse a degenerate page into a single page-sized panel whose beats are
 *  every text region flattened into reading order. */
export function montagePage(page: PageManifest): PageManifest {
  const W = page.width;
  const H = page.height;
  const beats = page.panels
    .flatMap((p) => p.beats ?? [])
    .filter((b) => b.w >= MONTAGE_MIN_BEAT_PX && b.h >= MONTAGE_MIN_BEAT_PX);

  const ordered = orderBeatsForReading(beats, W, H);

  if (ordered.length === 0) {
    // Nothing to read into — pure full-page splash.
    return { ...page, montage: true, panels: [] };
  }

  const panel: Panel = {
    x: 0,
    y: 0,
    w: W,
    h: H,
    centerX: Math.round(W / 2),
    centerY: Math.round(H / 2),
    beats: ordered,
  };
  return { ...page, montage: true, panels: [panel] };
}

/** Minimum empty strip (as a fraction of the page) that separates beats into
 *  distinct reading groups. The horizontal threshold is tighter than the
 *  vertical one because columns sit closer together than the gaps between
 *  montage rows / grid rows. */
const READ_CUT_GAP_X = 0.025;
const READ_CUT_GAP_Y = 0.04;

/**
 * Order flattened beats into natural comic reading order via a recursive
 * XY-cut. We slice the region at empty strips, alternating axes: horizontal
 * cuts split it into stacked bands (montage rows, grid rows), vertical cuts
 * split a band into columns. Recursing down each column keeps a panel's stacked
 * dialogue together, then reads columns left-to-right and bands top-to-bottom —
 * the way a comic page is actually read. (A flat row sort can't do this: when an
 * adjacent column has a balloon at an in-between height, it interleaves the two
 * columns and the camera bounces between panels.)
 */
function orderBeatsForReading(beats: FocusRegion[], W: number, H: number): FocusRegion[] {
  if (beats.length <= 1) return [...beats];
  const gapX = Math.max(1, W * READ_CUT_GAP_X);
  const gapY = Math.max(1, H * READ_CUT_GAP_Y);
  return xyCut(beats, "y", gapX, gapY);
}

function xyCut(
  beats: FocusRegion[],
  prefer: "x" | "y",
  gapX: number,
  gapY: number,
): FocusRegion[] {
  if (beats.length <= 1) return beats;
  const axes = prefer === "y" ? (["y", "x"] as const) : (["x", "y"] as const);
  for (const axis of axes) {
    const groups = splitByGap(beats, axis, axis === "x" ? gapX : gapY);
    if (groups.length > 1) {
      const next = axis === "y" ? "x" : "y";
      return groups.flatMap((g) => xyCut(g, next, gapX, gapY));
    }
  }
  // No gap on either axis — an interleaved cluster. Read top-to-bottom, then
  // left-to-right.
  return [...beats].sort((a, b) => a.y - b.y || a.centerX - b.centerX);
}

/** Split beats into position-ordered groups separated by an empty strip
 *  (> minGap) along the given axis. */
function splitByGap(
  beats: FocusRegion[],
  axis: "x" | "y",
  minGap: number,
): FocusRegion[][] {
  const lo = (b: FocusRegion) => (axis === "y" ? b.y : b.x);
  const hi = (b: FocusRegion) => (axis === "y" ? b.y + b.h : b.x + b.w);
  const sorted = [...beats].sort((a, b) => lo(a) - lo(b));
  const groups: FocusRegion[][] = [];
  let current: FocusRegion[] = [];
  let reach = -Infinity;
  for (const b of sorted) {
    if (current.length > 0 && lo(b) - reach > minGap) {
      groups.push(current);
      current = [];
    }
    current.push(b);
    reach = Math.max(reach, hi(b));
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Replace every degenerate page (never the cover) with its montage form. */
export function normalizeMontagePages(manifest: IssueManifest): IssueManifest {
  return {
    ...manifest,
    pages: manifest.pages.map((page, idx) =>
      idx > 0 && isDegeneratePage(page) ? montagePage(page) : page,
    ),
  };
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
