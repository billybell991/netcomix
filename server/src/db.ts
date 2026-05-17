import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL env var required");

// Railway's internal Postgres (postgres.railway.internal) does not require SSL.
// External connections do.
const isInternal = DATABASE_URL.includes("railway.internal");
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isInternal ? false : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (err) => console.error("pg pool error:", err));

// R2 public base URL — stored once, prepended to every r2Key at query time.
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, "");
function r2Url(key: string | null | undefined): string | null {
  if (!key || !R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL}/${key}`;
}

// ─── Schema migration (idempotent) ───────────────────────────────────────────

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
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
    `);
    await client.query(`
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
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS issues_series_id ON issues(series_id)
    `);
    console.log("✓ DB schema up to date");
  } finally {
    client.release();
  }
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export const db = {
  async getLibrary() {
    const { rows } = await pool.query<{
      id: string; title: string;
      cover_r2_key: string | null; issue_count: number; path: string;
    }>(`SELECT id, title, cover_r2_key, issue_count, path FROM series ORDER BY title`);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      issueCount: r.issue_count,
      coverUrl: r2Url(r.cover_r2_key),
      path: r.path,
    }));
  },

  async getSeries(id: string) {
    const { rows: seriesRows } = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM series WHERE id = $1`,
      [id],
    );
    if (!seriesRows[0]) return null;
    const series = seriesRows[0];
    const { rows: issues } = await pool.query<{
      id: string; title: string;
      cover_r2_key: string | null; page_count: number;
    }>(
      `SELECT id, title, cover_r2_key, page_count FROM issues WHERE series_id = $1 ORDER BY id`,
      [id],
    );
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
    const { rows } = await pool.query<{
      id: string; title: string; series_id: string;
      cover_r2_key: string | null; pages: PageRow[];
    }>(`SELECT id, title, series_id, cover_r2_key, pages FROM issues WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    const issue = rows[0];
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

  async bulkMigrate(series: SeriesInput[], issues: IssueInput[]) {
    const client = await pool.connect();
    try {
      const now = new Date();
      for (const s of series) {
        await client.query(
          `INSERT INTO series
             (id, title, path, issue_count, cover_r2_key, cover_drive_id, drive_folder_id, generated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             title           = EXCLUDED.title,
             path            = EXCLUDED.path,
             issue_count     = EXCLUDED.issue_count,
             cover_r2_key    = COALESCE(EXCLUDED.cover_r2_key, series.cover_r2_key),
             cover_drive_id  = COALESCE(EXCLUDED.cover_drive_id, series.cover_drive_id),
             drive_folder_id = COALESCE(EXCLUDED.drive_folder_id, series.drive_folder_id),
             generated_at    = EXCLUDED.generated_at`,
          [s.id, s.title, s.path, s.issue_count,
           s.cover_r2_key ?? null, s.cover_drive_id ?? null, s.drive_folder_id ?? null, now],
        );
      }
      for (const i of issues) {
        await client.query(
          `INSERT INTO issues
             (id, series_id, title, page_count, pages,
              cover_r2_key, cover_drive_id, drive_file_id, generated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             series_id      = EXCLUDED.series_id,
             title          = EXCLUDED.title,
             page_count     = EXCLUDED.page_count,
             pages          = EXCLUDED.pages,
             cover_r2_key   = COALESCE(EXCLUDED.cover_r2_key, issues.cover_r2_key),
             cover_drive_id = COALESCE(EXCLUDED.cover_drive_id, issues.cover_drive_id),
             drive_file_id  = COALESCE(EXCLUDED.drive_file_id, issues.drive_file_id),
             generated_at   = EXCLUDED.generated_at`,
          [i.id, i.series_id, i.title, i.page_count, JSON.stringify(i.pages),
           i.cover_r2_key ?? null, i.cover_drive_id ?? null, i.drive_file_id ?? null, now],
        );
      }
    } finally {
      client.release();
    }
    return { seriesCount: series.length, issueCount: issues.length };
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

export interface SeriesInput {
  id: string;
  title: string;
  path: string;
  issue_count: number;
  cover_r2_key?: string | null;
  cover_drive_id?: string | null;
  drive_folder_id?: string | null;
}

export interface IssueInput {
  id: string;
  series_id: string;
  title: string;
  page_count: number;
  pages: unknown[];
  cover_r2_key?: string | null;
  cover_drive_id?: string | null;
  drive_file_id?: string | null;
}

