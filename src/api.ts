// Railway API client — replaces static JSON fetches when apiUrl is configured.

import { getConfig } from "./config";
import type { IssueManifest, Library, SeriesIndex } from "./types";

function base(): string {
  return getConfig().apiUrl.replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const code = getConfig().accessCode;
  return code ? { Authorization: `Bearer ${code}` } : {};
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: headers() });
  if (res.status === 401) throw new Error("api:unauthorized");
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function validateCode(code: string): Promise<boolean> {
  const res = await fetch(`${base()}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return res.ok;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

export async function apiLibrary(): Promise<Library> {
  const data = await apiFetch<{ generatedAt: string; series: ApiSeries[] }>("/api/library");
  return {
    generatedAt: data.generatedAt,
    series: data.series.map((s) => ({
      id: s.id,
      title: s.title,
      cover: "",
      issueCount: s.issueCount,
      path: s.path,
      coverUrl: s.coverUrl ?? undefined,
    })),
  };
}

export async function apiSeries(id: string): Promise<SeriesIndex> {
  const data = await apiFetch<ApiSeriesDetail>(`/api/series/${id}`);
  return {
    id: data.id,
    title: data.title,
    issues: data.issues.map((i) => ({
      id: i.id,
      title: i.title,
      cover: "",
      pageCount: i.pageCount,
      path: i.path,
      coverUrl: i.coverUrl ?? undefined,
    })),
  };
}

export async function apiIssue(id: string): Promise<IssueManifest> {
  const data = await apiFetch<ApiIssue>(`/api/issue/${id}`);
  return {
    id: data.id,
    title: data.title,
    series: data.series,
    cover: data.coverUrl ?? "",
    pages: data.pages.map((p) => ({
      file: p.file,
      url: p.url ?? undefined,
      width: p.width,
      height: p.height,
      panels: p.panels,
      dominantColor: p.dominantColor ?? undefined,
    })),
  };
}

// ─── API response shapes (internal) ─────────────────────────────────────────

interface ApiSeries {
  id: string; title: string; issueCount: number; coverUrl: string | null; path: string;
}
interface ApiSeriesDetail {
  id: string; title: string;
  issues: { id: string; title: string; coverUrl: string | null; pageCount: number; path: string }[];
}
interface ApiIssue {
  id: string; title: string; series: string; coverUrl: string | null;
  pages: { file: string; url: string | null; width: number; height: number;
           panels: { x: number; y: number; w: number; h: number; centerX: number; centerY: number }[];
           dominantColor: string | null }[];
}
