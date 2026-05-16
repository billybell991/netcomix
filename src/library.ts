// Library fetch helpers — Drive-backed when configured, static /comics/ fallback otherwise.

import { getConfig, isDriveConfigured } from "./config";
import { fetchJsonById, findByName, mediaUrl } from "./drive";
import type { IssueIndexEntry, IssueManifest, Library, PageManifest, SeriesEntry, SeriesIndex } from "./types";

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

// ─── Public API (dispatches to Drive or static based on config) ────────────

export async function fetchLibrary(): Promise<Library> {
  if (isDriveConfigured()) {
    const root = getConfig().driveFolderId;
    const lib = await findByName(root, "library.json");
    if (!lib) throw new Error("library.json not found in Drive folder — run a Scan first.");
    return fetchJsonById<Library>(lib.id);
  }
  return fetchJson<Library>(`${COMICS_BASE}library.json`);
}

export async function fetchSeries(seriesPath: string, series?: SeriesEntry): Promise<SeriesIndex> {
  if (isDriveConfigured()) {
    if (!series?.seriesFileId) throw new Error(`Series ${seriesPath} missing seriesFileId.`);
    return fetchJsonById<SeriesIndex>(series.seriesFileId);
  }
  return fetchJson<SeriesIndex>(`${COMICS_BASE}${seriesPath}/series.json`);
}

export async function fetchIssue(issuePath: string, issue?: IssueIndexEntry): Promise<IssueManifest> {
  if (isDriveConfigured()) {
    if (!issue?.issueFileId) throw new Error(`Issue ${issuePath} missing issueFileId.`);
    return fetchJsonById<IssueManifest>(issue.issueFileId);
  }
  return fetchJson<IssueManifest>(`${COMICS_BASE}${issuePath}/issue.json`);
}

/** URL for a page image — drive media URL when page has fileId, else static path. */
export function pageUrl(issuePath: string, fileOrPage: string | PageManifest): string {
  if (typeof fileOrPage !== "string" && fileOrPage.fileId && isDriveConfigured()) {
    return mediaUrl(fileOrPage.fileId);
  }
  const file = typeof fileOrPage === "string" ? fileOrPage : fileOrPage.file;
  return `${COMICS_BASE}${issuePath}/${file}`;
}

/** URL for a cover thumbnail. Prefer fileId in drive mode. */
export function coverUrl(basePath: string, file: string, fileId?: string): string {
  if (fileId && isDriveConfigured()) return mediaUrl(fileId);
  return `${COMICS_BASE}${basePath}/${file}`;
}
