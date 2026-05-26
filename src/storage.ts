// Tiny persistence helpers for favorites + reading progress.

const FAV_KEY = "netcomix.favorites.v1";
const PROGRESS_KEY = "netcomix.progress.v1";

export function getFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function toggleFavorite(seriesId: string): string[] {
  const favs = new Set(getFavorites());
  if (favs.has(seriesId)) favs.delete(seriesId);
  else favs.add(seriesId);
  const out = Array.from(favs);
  try { localStorage.setItem(FAV_KEY, JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}

export function isFavorite(seriesId: string): boolean {
  return getFavorites().includes(seriesId);
}

interface ProgressMap { [issueId: string]: string }

function readProgress(): ProgressMap {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

export function getProgress(issueId: string): string | undefined {
  return readProgress()[issueId];
}

export function setProgress(issueId: string, serialized: string): void {
  const map = readProgress();
  map[issueId] = serialized;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// ─── Last-read tracking ───────────────────────────────────────────────────

const LAST_READ_KEY = "netcomix.lastread.v1";

export interface LastRead {
  seriesId: string;
  issueId: string;
}

export function getLastRead(): LastRead | null {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "seriesId" in parsed &&
      "issueId" in parsed &&
      typeof (parsed as LastRead).seriesId === "string" &&
      typeof (parsed as LastRead).issueId === "string"
    ) {
      return parsed as LastRead;
    }
    return null;
  } catch {
    return null;
  }
}

export function setLastRead(seriesId: string, issueId: string): void {
  try {
    localStorage.setItem(LAST_READ_KEY, JSON.stringify({ seriesId, issueId }));
  } catch { /* ignore */ }
}

// ─── In-progress series detection ────────────────────────────────────────
// A series is "in progress" if at least one of its issues has pageIndex > 0.
// Issues are matched to series by the naming convention used by the harvester:
// issue slugs start with the series slug followed by a hyphen
// (e.g. "tales-from-the-crypt-v2-01" starts with "tales-from-the-crypt-v2-").

export function getInProgressSeriesIds(allSeriesIds: string[]): string[] {
  const progressMap = readProgress();
  const inProgress = new Set<string>();
  for (const [issueId, progress] of Object.entries(progressMap)) {
    const pageIndex = parseInt(progress.split(":")[0], 10);
    if (isNaN(pageIndex) || pageIndex <= 0) continue;
    for (const seriesId of allSeriesIds) {
      if (issueId.startsWith(seriesId + "-") || issueId === seriesId) {
        inProgress.add(seriesId);
        break;
      }
    }
  }
  return Array.from(inProgress);
}

// ─── Series-level progress fraction ──────────────────────────────────────
// Returns the fraction (0–1) of a series' issues that have been started
// (pageIndex > 0). Uses the same prefix-matching convention as getInProgressSeriesIds.

export function getSeriesStartedFraction(seriesId: string, issueCount: number): number {
  if (issueCount === 0) return 0;
  const progressMap = readProgress();
  let started = 0;
  for (const [issueId, progress] of Object.entries(progressMap)) {
    if (!issueId.startsWith(seriesId + "-") && issueId !== seriesId) continue;
    if (parseInt(progress.split(":")[0], 10) > 0) started++;
  }
  return Math.min(started / issueCount, 1);
}
