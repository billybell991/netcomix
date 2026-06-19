// In-memory structured logger for the browser-side upload pipeline.
//
// The NetComix PWA has no traditional backend — uploads go directly from
// the browser to the GitHub REST API. This module captures every step of
// that pipeline so that "TypeError: failed to fetch" and similar opaque
// browser fetch failures can be diagnosed after the fact:
//
//   * Each entry is also pushed to console.{log|warn|error} so it shows up
//     in the embedded VS Code browser DevTools / regular browser DevTools.
//   * Entries are retained in a ring buffer (max 500) so the user can
//     `getUploadLogText()` and paste the whole timeline.
//   * Subscribers can react to new entries (used by AdminView for a live
//     log panel).

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;        // epoch ms
  iso: string;      // ISO timestamp (UTC)
  level: LogLevel;
  event: string;    // short stable identifier, e.g. "uploadBlob.start"
  data?: unknown;   // free-form structured payload
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
const subscribers = new Set<(entries: LogEntry[]) => void>();

function notify(): void {
  for (const fn of subscribers) {
    try { fn(buffer.slice()); } catch { /* ignore subscriber errors */ }
  }
}

/** Strip File / Blob / large arrays to keep the buffer printable. */
function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (typeof File !== "undefined" && value instanceof File) {
    return { __file__: true, name: value.name, size: value.size, type: value.type };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { __blob__: true, size: value.size, type: value.type };
  }
  if (value instanceof Error) {
    return {
      __error__: true,
      name: value.name,
      message: value.message,
      stack: value.stack,
      // Some browsers expose .cause on TypeError; include if present.
      cause: (value as { cause?: unknown }).cause,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function logUpload(level: LogLevel, event: string, data?: unknown): void {
  const now = Date.now();
  const entry: LogEntry = {
    t: now,
    iso: new Date(now).toISOString(),
    level,
    event,
    data: data === undefined ? undefined : sanitize(data),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  const fn = level === "error" ? console.error
    : level === "warn" ? console.warn
    : console.log;
  if (entry.data === undefined) {
    fn(`[upload] ${event}`);
  } else {
    fn(`[upload] ${event}`, entry.data);
  }
  notify();
}

export function clearUploadLog(): void {
  buffer.length = 0;
  notify();
}

export function getUploadLog(): LogEntry[] {
  return buffer.slice();
}

/** Render the full log as plain text — suitable for clipboard / bug reports. */
export function getUploadLogText(): string {
  return buffer
    .map((e) => {
      const head = `${e.iso} [${e.level.toUpperCase()}] ${e.event}`;
      if (e.data === undefined) return head;
      let payload: string;
      try {
        payload = JSON.stringify(e.data, null, 2);
      } catch {
        payload = String(e.data);
      }
      return `${head}\n${payload}`;
    })
    .join("\n");
}

export function subscribeUploadLog(fn: (entries: LogEntry[]) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Capture browser / environment context once at the start of an upload. */
export function logUploadContext(extra?: Record<string, unknown>): void {
  const ctx: Record<string, unknown> = { ...(extra ?? {}) };
  if (typeof navigator !== "undefined") {
    ctx.userAgent = navigator.userAgent;
    ctx.onLine = navigator.onLine;
    ctx.language = navigator.language;
    const conn = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
    if (conn) ctx.connection = { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt };
  }
  if (typeof location !== "undefined") ctx.href = location.href;
  if (typeof performance !== "undefined") ctx.now = Math.round(performance.now());
  logUpload("info", "context", ctx);
}
