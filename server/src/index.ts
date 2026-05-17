import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, migrate } from "./db.js";

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

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
await migrate();
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`✓ NetComix API listening on port ${PORT}`);
});
