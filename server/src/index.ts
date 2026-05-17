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

// ─── Admin: raw TCP diagnostic ────────────────────────────────────────────────
app.get("/api/admin/tcptest", async (c) => {
  const net = await import("node:net");
  const dns = await import("node:dns");
  const host = "postgres.railway.internal";
  const port = 5432;
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true }) as { address: string; family: number }[];
  } catch (e: any) {
    return c.json({ dnsError: e.message });
  }
  // Test IPv6 address specifically (Railway private network is IPv6)
  const ipv6 = addrs.find((a) => a.family === 6)?.address;
  if (!ipv6) return c.json({ addrs, error: "no IPv6 address found" });
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ipv6, port, family: 6 });
    let timer: NodeJS.Timeout;
    socket.on("connect", () => {
      socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); // SSLRequest
      timer = setTimeout(() => { socket.destroy(); resolve(c.json({ addrs, ipv6, connected: true, timedOut: true })); }, 5000);
    });
    socket.on("data", (d) => {
      clearTimeout(timer); socket.destroy();
      resolve(c.json({ addrs, ipv6, connected: true, firstByte: d[0], firstByteChar: String.fromCharCode(d[0]), hex: d.slice(0, 20).toString("hex") }));
    });
    socket.on("error", (e: any) => {
      clearTimeout(timer);
      resolve(c.json({ addrs, ipv6, connected: false, error: e.message, code: e.code }));
    });
  });
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
