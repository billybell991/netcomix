import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, migrate, pool } from "./db.js";

const app = new Hono();

const ACCESS_CODE = process.env.ACCESS_CODE ?? "";
const PORT = parseInt(process.env.PORT ?? "3000");

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
);

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use("/api/*", async (c, next) => {
  // No ACCESS_CODE set → open (for local dev / initial setup)
  if (!ACCESS_CODE) return next();
  const auth = c.req.header("Authorization") ?? "";
  const code = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (code !== ACCESS_CODE) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post("/api/auth", async (c) => {
  const body = await c.req.json<{ code?: string }>();
  if (!ACCESS_CODE || body.code === ACCESS_CODE) {
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: "Invalid access code" }, 401);
});

// ─── Library ──────────────────────────────────────────────────────────────────
app.get("/api/library", async (c) => {
  try {
    const series = await db.getLibrary();
    return c.json({ generatedAt: new Date().toISOString(), series });
  } catch (e) {
    console.error("GET /api/library", e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Series ───────────────────────────────────────────────────────────────────
app.get("/api/series/:id", async (c) => {
  try {
    const series = await db.getSeries(c.req.param("id"));
    if (!series) return c.json({ error: "Not found" }, 404);
    return c.json(series);
  } catch (e) {
    console.error("GET /api/series/:id", e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Issue ────────────────────────────────────────────────────────────────────
app.get("/api/issue/:id", async (c) => {
  try {
    const issue = await db.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "Not found" }, 404);
    return c.json(issue);
  } catch (e) {
    console.error("GET /api/issue/:id", e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Admin: DB connection test ────────────────────────────────────────────────
app.get("/api/admin/dbtest", async (c) => {
  try {
    const { rows } = await pool.query("SELECT 1 AS val");
    return c.json({ ok: true, val: rows[0]?.val });
  } catch (e: any) {
    console.error("GET /api/admin/dbtest", e);
    return c.json({ ok: false, error: e.message, code: e.code }, 500);
  }
});

// ─── Admin: issue list for re-detect helper ───────────────────────────────────
app.get("/api/admin/issues", async (c) => {
  try {
    const issues = await db.getAdminIssues();
    return c.json(issues);
  } catch (e) {
    console.error("GET /api/admin/issues", e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Admin: bulk migrate ──────────────────────────────────────────────────────
app.post("/api/admin/migrate", async (c) => {
  try {
    const body = await c.req.json<{ series?: unknown[]; issues?: unknown[] }>();
    if (!Array.isArray(body.series) || !Array.isArray(body.issues)) {
      return c.json({ error: "Body must have series[] and issues[] arrays" }, 400);
    }
    const result = await db.bulkMigrate(
      body.series as Parameters<typeof db.bulkMigrate>[0],
      body.issues as Parameters<typeof db.bulkMigrate>[1],
    );
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("POST /api/admin/migrate", e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`✓ NetComix API listening on port ${PORT}`);
  migrate().catch((e) => console.error("Migration error (non-fatal):", e));
});
