import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL env var required");

export const sql = postgres(DATABASE_URL, {
  // Railway internal connections (postgres.railway.internal) don't need SSL.
  // External connections (public proxy URL) do.
  ssl: DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false },
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

  async bulkMigrate(series: SeriesInput[], issues: IssueInput[]) {
    const now = new Date();
    for (const s of series) {
      await sql`
        INSERT INTO series
          (id, title, path, issue_count, cover_r2_key, cover_drive_id, drive_folder_id, generated_at)
        VALUES
          (${s.id}, ${s.title}, ${s.path}, ${s.issue_count},
           ${s.cover_r2_key ?? null}, ${s.cover_drive_id ?? null},
           ${s.drive_folder_id ?? null}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          title           = EXCLUDED.title,
          path            = EXCLUDED.path,
          issue_count     = EXCLUDED.issue_count,
          cover_r2_key    = COALESCE(EXCLUDED.cover_r2_key, series.cover_r2_key),
          cover_drive_id  = COALESCE(EXCLUDED.cover_drive_id, series.cover_drive_id),
          drive_folder_id = COALESCE(EXCLUDED.drive_folder_id, series.drive_folder_id),
          generated_at    = EXCLUDED.generated_at
      `;
    }
    for (const i of issues) {
      await sql`
        INSERT INTO issues
          (id, series_id, title, page_count, pages,
           cover_r2_key, cover_drive_id, drive_file_id, generated_at)
        VALUES
          (${i.id}, ${i.series_id}, ${i.title}, ${i.page_count},
           ${sql.json(i.pages)},
           ${i.cover_r2_key ?? null}, ${i.cover_drive_id ?? null},
           ${i.drive_file_id ?? null}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          series_id      = EXCLUDED.series_id,
          title          = EXCLUDED.title,
          page_count     = EXCLUDED.page_count,
          pages          = EXCLUDED.pages,
          cover_r2_key   = COALESCE(EXCLUDED.cover_r2_key, issues.cover_r2_key),
          cover_drive_id = COALESCE(EXCLUDED.cover_drive_id, issues.cover_drive_id),
          drive_file_id  = COALESCE(EXCLUDED.drive_file_id, issues.drive_file_id),
          generated_at   = EXCLUDED.generated_at
      `;
    }
    return { seriesCount: series.length, issueCount: issues.length };
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

interface SeriesInput {
  id: string;
  title: string;
  path: string;
  issue_count: number;
  cover_r2_key?: string | null;
  cover_drive_id?: string | null;
  drive_folder_id?: string | null;
}

interface IssueInput {
  id: string;
  series_id: string;
  title: string;
  page_count: number;
  pages: unknown[];
  cover_r2_key?: string | null;
  cover_drive_id?: string | null;
  drive_file_id?: string | null;
}
