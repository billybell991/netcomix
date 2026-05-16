// Library fetch helpers — reads JSON manifests from the configured base.

import type { IssueManifest, Library, SeriesIndex } from "./types";

/**
 * Comics base path. Defaults to /comics/ (served from /public/comics by Vite
 * → committed by the GitHub Action harvester). Can be overridden by setting
 * VITE_COMICS_BASE at build time (e.g. to point at a Drive-backed CDN).
 */
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

export async function fetchLibrary(): Promise<Library> {
  return fetchJson<Library>(`${COMICS_BASE}library.json`);
}

export async function fetchSeries(seriesPath: string): Promise<SeriesIndex> {
  return fetchJson<SeriesIndex>(`${COMICS_BASE}${seriesPath}/series.json`);
}

export async function fetchIssue(issuePath: string): Promise<IssueManifest> {
  return fetchJson<IssueManifest>(`${COMICS_BASE}${issuePath}/issue.json`);
}

export function pageUrl(issuePath: string, file: string): string {
  return `${COMICS_BASE}${issuePath}/${file}`;
}

export function coverUrl(basePath: string, file: string): string {
  return `${COMICS_BASE}${basePath}/${file}`;
}
