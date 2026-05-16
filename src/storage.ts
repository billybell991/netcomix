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
