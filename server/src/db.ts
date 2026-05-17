import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL env var required");

export const sql = postgres(DATABASE_URL, {
  ssl: process.env.NODE_ENV === "production" ? "require" : false,
  max: 10,
});

// R2 public base URL — stored once, prepended to every r2Key at query time.
// Change this env var (e.g. custom domain) without touching DB rows.
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, "");

function r2Url(key: string | null | undefined): string | null {
  if (!key || !R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL}/${key}`;
}

// ─── Schema migration (idempotent) ───────────────────────────────────────────

export async function migrate(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS series (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      cover_r2_key    TEXT,
      cover_drive_id  TEXT,
      issue_count     INT  NOT NULL DEFAULT 0,
      path            TEXT NOT NULL,
      drive_folder_id TEXT,
      generated_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS issues (
      id             TEXT PRIMARY KEY,
      series_id      TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      cover_r2_key   TEXT,
      cover_drive_id TEXT,
      drive_file_id  TEXT,
      page_count     INT  NOT NULL DEFAULT 0,
      pages          JSONB NOT NULL DEFAULT '[]',
      generated_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS issues_series_id ON issues(series_id)
  `;
  console.log("✓ DB schema up to date");
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export const db = {
  async getLibrary() {
    const rows = await sql<{
      id: string; title: string;
      cover_r2_key: string | null; issue_count: number; path: string;
    }[]>`
      SELECT id, title, cover_r2_key, issue_count, path
      FROM series ORDER BY title
    `;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      issueCount: r.issue_count,
      coverUrl: r2Url(r.cover_r2_key),
      path: r.path,
    }));
  },

  async getSeries(id: string) {
    const [series] = await sql<{ id: string; title: string }[]>`
      SELECT id, title FROM series WHERE id = ${id}
    `;
    if (!series) return null;
    const issues = await sql<{
      id: string; title: string;
      cover_r2_key: string | null; page_count: number;
    }[]>`
      SELECT id, title, cover_r2_key, page_count
      FROM issues WHERE series_id = ${id} ORDER BY id
    `;
    return {
      id: series.id,
      title: series.title,
      issues: issues.map((i) => ({
        id: i.id,
        title: i.title,
        coverUrl: r2Url(i.cover_r2_key),
        pageCount: i.page_count,
        path: `${id}/${i.id}`,
      })),
    };
  },

  async getIssue(id: string) {
    const [issue] = await sql<{
      id: string; title: string; series_id: string;
      cover_r2_key: string | null; pages: PageRow[];
    }[]>`
      SELECT id, title, series_id, cover_r2_key, pages FROM issues WHERE id = ${id}
    `;
    if (!issue) return null;
    return {
      id: issue.id,
      title: issue.title,
      series: issue.series_id,
      coverUrl: r2Url(issue.cover_r2_key),
      pages: (issue.pages as PageRow[]).map((p) => ({
        file: p.file,
        url: r2Url(p.r2Key) ?? null,
        width: p.width,
        height: p.height,
        panels: p.panels ?? [],
        dominantColor: p.dominantColor ?? null,
      })),
    };
  },
};

interface PageRow {
  file: string;
  r2Key: string;
  width: number;
  height: number;
  panels: { x: number; y: number; w: number; h: number; centerX: number; centerY: number }[];
  dominantColor?: string;
}
