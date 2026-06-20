// Trigger a GitHub Actions workflow_dispatch and poll its status.

import { getConfig, isGithubConfigured } from "./config";
import { logUpload } from "./upload-log";

const GH_API = "https://api.github.com";

export interface WorkflowRun {
  id: number;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | null
  html_url: string;
  created_at: string;
}

function authHeaders(): HeadersInit {
  const { ghToken } = getConfig();
  if (!ghToken) throw new Error("GitHub token not configured");
  return {
    // GitHub accepts both "Bearer <pat>" and "token <pat>". We use 'token'
    // because some intermediaries (corporate proxies, mobile carrier MITM
    // boxes, even Workbox service workers in certain edge cases) treat
    // 'Bearer' specially and rewrite the header, which silently corrupts the
    // credential and produces a spurious 401 "Bad credentials" from GitHub.
    Authorization: `token ${ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Standard fetch options for every GitHub REST call — prevents cookie /
 *  service-worker interference that we've seen mangling Authorization on
 *  large POST bodies. */
const GH_FETCH_INIT: Pick<RequestInit, "credentials" | "cache" | "mode" | "redirect"> = {
  credentials: "omit",
  cache: "no-store",
  mode: "cors",
  redirect: "follow",
};

/**
 * Fast pre-flight check that the configured token can both (a) authenticate
 * and (b) write to the target repo. Costs ~1 KB / ~1 second — a tiny price
 * compared with discovering a bad token after a 3-minute chunk upload.
 *
 * Strategy: try to create an empty tree based on main's current tree. This
 * requires the same "Contents: Read and write" permission as the real upload
 * but transfers almost no bytes. A successful response (201) or a benign
 * 422 ("tree must contain at least one entry") both prove the token is good.
 */
export async function preflightAuth(): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  logUpload("info", "preflightAuth.start", { repo: `${ghOwner}/${ghRepo}` });

  // 1) Cheapest possible auth check: read the repo's default branch ref.
  //    Returns 401 if the token doesn't exist, 404 if it can't see the repo,
  //    200 if at least Metadata read is granted.
  let refRes: Response;
  try {
    refRes = await fetch(`${base}/git/ref/heads/main`, { ...GH_FETCH_INIT, headers: authHeaders() });
  } catch (e) {
    logUpload("error", "preflightAuth.networkFailed", { error: e, onLine: typeof navigator !== "undefined" ? navigator.onLine : null });
    throw new Error("Network error reaching api.github.com — check your connection and try again.");
  }
  if (refRes.status === 401) {
    const body = await refRes.text();
    logUpload("error", "preflightAuth.401", { body: body.slice(0, 300) });
    throw new Error(
      `GitHub 401 — your Personal Access Token is invalid, expired, or doesn't grant access to ${ghOwner}/${ghRepo}. Go to Setup and paste a fresh fine-grained PAT with Repository access = ${ghOwner}/${ghRepo} and Repository permissions: Contents = Read and write, Metadata = Read, Actions = Read and write.`
    );
  }
  if (refRes.status === 404) {
    logUpload("error", "preflightAuth.404", {});
    throw new Error(
      `GitHub 404 — the token can authenticate but can't see ${ghOwner}/${ghRepo}. In Setup, check the repo owner/name are correct, and in your PAT settings make sure Repository access includes ${ghOwner}/${ghRepo}.`
    );
  }
  if (!refRes.ok) {
    const body = await refRes.text();
    logUpload("error", "preflightAuth.refHttpError", { status: refRes.status, body: body.slice(0, 300) });
    throw new Error(`GitHub ${refRes.status} while checking repo access: ${body.slice(0, 200)}`);
  }

  // 2) Write check: create a tree with one entry that won't actually be linked
  //    to a commit. POST /git/trees costs almost no bytes and tells us whether
  //    Contents: write is granted. Use the existing root tree as base so the
  //    request is valid — we never reference the returned tree sha.
  const { object: { sha: headSha } } = await refRes.json() as { object: { sha: string } };
  const commitRes = await fetch(`${base}/git/commits/${headSha}`, { ...GH_FETCH_INIT, headers: authHeaders() });
  if (!commitRes.ok) {
    const body = await commitRes.text();
    logUpload("error", "preflightAuth.commitReadHttpError", { status: commitRes.status, body: body.slice(0, 300) });
    throw new Error(`GitHub ${commitRes.status} while reading HEAD commit: ${body.slice(0, 200)}`);
  }
  const { tree: { sha: treeSha } } = await commitRes.json() as { tree: { sha: string } };

  const writeRes = await fetch(`${base}/git/trees`, {
    ...GH_FETCH_INIT,
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    // base_tree only, empty tree array — GitHub returns 422 "tree must contain
    // at least one entry" if the token CAN write but the payload is empty.
    // That 422 is exactly what we want: it proves write access without
    // actually mutating anything.
    body: JSON.stringify({ base_tree: treeSha, tree: [] }),
  });
  if (writeRes.status === 401 || writeRes.status === 403) {
    const body = await writeRes.text();
    logUpload("error", "preflightAuth.writeDenied", { status: writeRes.status, body: body.slice(0, 300) });
    throw new Error(
      `GitHub ${writeRes.status} — your PAT can read ${ghOwner}/${ghRepo} but not write. In your token settings (https://github.com/settings/tokens?type=beta), edit the token and set Repository permissions → Contents → Read and write, then save. The token value stays the same.`
    );
  }
  // 422 means: token CAN write, payload was just empty. Treat as success.
  if (writeRes.ok || writeRes.status === 422) {
    logUpload("info", "preflightAuth.ok", { writeStatus: writeRes.status });
    return;
  }
  const body = await writeRes.text();
  logUpload("error", "preflightAuth.writeHttpError", { status: writeRes.status, body: body.slice(0, 300) });
  throw new Error(`GitHub ${writeRes.status} during write check: ${body.slice(0, 200)}`);
}

export async function triggerScan(): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/scan.yml/dispatches`,
    {
      ...GH_FETCH_INIT,
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Scan dispatch denied (${res.status}). Check that your Personal Access Token has "Actions: Read and write" on ${ghOwner}/${ghRepo}.`
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Scan workflow not found (404). Make sure .github/workflows/scan.yml is committed to main on ${ghOwner}/${ghRepo}.`
      );
    }
    throw new Error(`Scan dispatch failed: ${res.status} ${body}`);
  }
}

export async function latestScanRun(): Promise<WorkflowRun | null> {
  if (!isGithubConfigured()) return null;
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/scan.yml/runs?per_page=1`,
    { ...GH_FETCH_INIT, headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`List runs failed: ${res.status}`);
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs[0] ?? null;
}

/**
 * Commit a CBR/CBZ archive to comics-source/ using the Git Data API (blobs+trees+commits).
 * This avoids the Contents API's 10-second branch-protection validation timeout that
 * triggers on large files (the blob upload has no validation; only the tiny ref-update does).
 */
/**
 * Upload multiple CBR/CBZ files (any size) to comics-source/ in a SINGLE commit.
 *
 * Strategy:
 *  1. Files ≤ 15 MB  → committed as-is.
 *  2. Files  > 15 MB → split into 15 MB chunks committed as
 *     {filename}.part001, .part002, … (scan.yml reassembles them before processing).
 *
 * All blobs are uploaded first (content-addressed, no branch locking), then
 * a SINGLE tree+commit+ref-PATCH is executed with up to 10 retries.
 * One PATCH = one chance for a race condition, vs. one per chunk with the old approach.
 */

// 1 MB raw → ~1.4 MB base64. At 0.35 Mbps (camp WiFi) each chunk uploads in
// ~30 seconds, comfortably under GitHub's request-body timeout and anti-abuse
// thresholds that drop slow-trickle uploads. At 50 Mbps each chunk is <1s, so
// the small chunk size adds minimal overhead on fast links either.
const CHUNK_SIZE = 1 * 1024 * 1024;
const BLOB_RETRY_LIMIT = 5;        // total attempts per chunk on transient failures (network / 5xx)

/** Progress reporting for the upload pipeline. */
export interface UploadProgress {
  /** Total committed fraction, 0..1. */
  pct?: (n: number) => void;
  /** Human-readable "what's happening now" string, e.g. "Uploading chunk 2 of 5 — 4.1 / 15.0 MB (52 KB/s)". */
  status?: (msg: string) => void;
}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/** Upload raw bytes to the Git Blobs API and return the blob sha. */
async function uploadBlob(data: Blob, label: string, chunkIdx: number, chunkTotal: number, progress?: UploadProgress): Promise<string> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  const url = `${base}/git/blobs`;
  const t0 = Date.now();
  logUpload('info', 'uploadBlob.start', { label, bytes: data.size, type: data.type, url });
  progress?.status?.(`Preparing chunk ${chunkIdx} of ${chunkTotal} (${fmtMB(data.size)})…`);

  // 1) Read the blob as base64. Big chunks (~15 MB → ~20 MB base64) can OOM
  //    on memory-constrained mobile browsers — log the exact step that fails.
  let base64: string;
  try {
    base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message ?? 'unknown'}`));
      reader.readAsDataURL(data);
    });
  } catch (e) {
    logUpload('error', 'uploadBlob.fileReaderFailed', { label, bytes: data.size, error: e });
    throw e;
  }
  logUpload('debug', 'uploadBlob.base64Ready', { label, base64Len: base64.length, ms: Date.now() - t0 });

  const body = JSON.stringify({ content: base64, encoding: 'base64' });

  // 2) POST via fetch(). Preflight uses fetch and works; XMLHttpRequest in
  //    Electron / some networks corrupts the Authorization header on long
  //    multi-MB uploads, producing a spurious 401 'Bad credentials' from
  //    GitHub with a valid request-id (proving the request reached the API).
  //    We trade per-byte upload progress for reliability; the shimmer overlay
  //    + chunk-level status text + small (5 MB) chunks keep the UI alive.
  let res: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BLOB_RETRY_LIMIT; attempt++) {
    const tUp = Date.now();
    if (attempt > 1) {
      const backoffMs = 1500 * attempt;
      progress?.status?.(`Retrying chunk ${chunkIdx} of ${chunkTotal} — attempt ${attempt}/${BLOB_RETRY_LIMIT} after ${backoffMs}ms…`);
      logUpload('warn', 'uploadBlob.retry', { label, attempt, lastError });
      await new Promise(r => setTimeout(r, backoffMs));
    }

    // Drive a periodic "still working" status update while the fetch is in
    // flight, since fetch() doesn't expose upload-byte progress.
    const tickHandle = window.setInterval(() => {
      const elapsedSec = Math.round((Date.now() - tUp) / 1000);
      progress?.status?.(
        `Uploading chunk ${chunkIdx} of ${chunkTotal} (${fmtMB(data.size)}) — ${elapsedSec}s elapsed${attempt > 1 ? ` [retry ${attempt}]` : ''}`
      );
    }, 1000);

    try {
      res = await fetch(url, {
        ...GH_FETCH_INIT,
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      window.clearInterval(tickHandle);
      lastError = e;
      logUpload('error', 'uploadBlob.fetchThrew', {
        label, url, attempt, bytes: data.size, base64Len: base64.length, ms: Date.now() - t0,
        onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
        error: e,
      });
      if (attempt < BLOB_RETRY_LIMIT) continue;
      throw e;
    }
    window.clearInterval(tickHandle);

    // 5xx → retry. 4xx → don't bother (auth/permission issues are persistent).
    if (res.status >= 500 && attempt < BLOB_RETRY_LIMIT) {
      const b = await res.text();
      lastError = `${res.status}: ${b.slice(0, 200)}`;
      logUpload('warn', 'uploadBlob.5xxRetry', { label, status: res.status, attempt, body: b.slice(0, 200) });
      continue;
    }
    break;
  }
  if (!res) throw lastError instanceof Error ? lastError : new Error(String(lastError));

  // 3) Log response metadata before reading the body — even on 5xx the
  //    rate-limit / request-id headers are diagnostic.
  const rlRemaining = res.headers.get('x-ratelimit-remaining');
  const rlReset = res.headers.get('x-ratelimit-reset');
  const reqId = res.headers.get('x-github-request-id');
  // Dump EVERY response header on non-OK responses — if anything is rewriting
  // our requests in flight (proxy, service worker, mobile carrier MITM box),
  // it usually leaves a fingerprint in via / x-served-by / cf-ray / server.
  const allHeaders: Record<string, string> = {};
  if (!res.ok) {
    res.headers.forEach((value, key) => { allHeaders[key] = value; });
  }
  logUpload(res.ok ? 'debug' : 'warn', 'uploadBlob.response', {
    label, status: res.status, ok: res.ok, ms: Date.now() - t0,
    rateLimitRemaining: rlRemaining, rateLimitReset: rlReset, requestId: reqId,
    ...(res.ok ? {} : { allHeaders }),
  });

  if (!res.ok) {
    const b = await res.text();
    logUpload('error', 'uploadBlob.httpError', { label, status: res.status, body: b.slice(0, 500), requestId: reqId });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitHub ${res.status} — authentication failed. Your Personal Access Token is missing, expired, or lacks "Contents: Read and write" on ${ghOwner}/${ghRepo}. Go to Setup and re-enter a fresh token.`
      );
    }
    throw new Error(`GitHub ${res.status}: ${b.slice(0, 300)}`);
  }
  const { sha } = await res.json() as { sha: string };
  logUpload('info', 'uploadBlob.done', { label, sha, ms: Date.now() - t0 });
  return sha;
}

/**
 * Wrapped fetch that logs the request lifecycle and converts a thrown
 * TypeError ("failed to fetch") into a structured log entry before rethrow.
 */
async function loggedFetch(step: string, url: string, init?: RequestInit): Promise<Response> {
  const t0 = Date.now();
  logUpload('debug', `${step}.fetch.start`, { url, method: init?.method ?? 'GET' });
  try {
    const res = await fetch(url, { ...GH_FETCH_INIT, ...init });
    logUpload(res.ok ? 'debug' : 'warn', `${step}.fetch.response`, {
      url, status: res.status, ok: res.ok, ms: Date.now() - t0,
      requestId: res.headers.get('x-github-request-id'),
      rateLimitRemaining: res.headers.get('x-ratelimit-remaining'),
    });
    return res;
  } catch (e) {
    logUpload('error', `${step}.fetch.threw`, {
      url, method: init?.method ?? 'GET', ms: Date.now() - t0,
      onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
      error: e,
    });
    throw e;
  }
}

/** Push a set of pre-uploaded blobs as ONE commit. Retries up to 10× on 422. */
async function pushEntries(
  entries: Array<{ path: string; sha: string }>,
  message: string,
  progress?: UploadProgress,
): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  logUpload('info', 'pushEntries.start', { entryCount: entries.length, message });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) {
      const waitMs = 3000 + attempt * 2000;
      progress?.status?.(`Branch was updated by another commit — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/10)…`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    logUpload('info', 'pushEntries.attempt', { attempt: attempt + 1 });

    progress?.status?.('Reading current branch HEAD…');
    const refRes = await loggedFetch('pushEntries.ref', `${base}/git/ref/heads/main`, { headers: authHeaders() });
    if (!refRes.ok) { const b = await refRes.text(); logUpload('error', 'pushEntries.ref.httpError', { status: refRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${refRes.status}: ${b.slice(0, 300)}`); }
    const { object: { sha: headSha } } = await refRes.json() as { object: { sha: string } };

    const commitRes = await loggedFetch('pushEntries.commitRead', `${base}/git/commits/${headSha}`, { headers: authHeaders() });
    if (!commitRes.ok) { const b = await commitRes.text(); logUpload('error', 'pushEntries.commitRead.httpError', { status: commitRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${commitRes.status}: ${b.slice(0, 300)}`); }
    const { tree: { sha: treeSha } } = await commitRes.json() as { tree: { sha: string } };

    progress?.status?.(`Building tree (${entries.length} file${entries.length === 1 ? '' : 's'})…`);
    const treeRes = await loggedFetch('pushEntries.tree', `${base}/git/trees`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: treeSha,
        tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
      }),
    });
    if (!treeRes.ok) { const b = await treeRes.text(); logUpload('error', 'pushEntries.tree.httpError', { status: treeRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${treeRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newTreeSha } = await treeRes.json() as { sha: string };

    progress?.status?.('Creating commit…');
    const newCommitRes = await loggedFetch('pushEntries.commitCreate', `${base}/git/commits`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: newTreeSha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) { const b = await newCommitRes.text(); logUpload('error', 'pushEntries.commitCreate.httpError', { status: newCommitRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${newCommitRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newCommitSha } = await newCommitRes.json() as { sha: string };

    progress?.pct?.(0.97);
    progress?.status?.('Pushing commit to main…');
    const updateRes = await loggedFetch('pushEntries.refUpdate', `${base}/git/refs/heads/main`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (updateRes.status === 422 && attempt < 9) {
      logUpload('warn', 'pushEntries.refUpdate.422retry', { attempt: attempt + 1 });
      continue; // HEAD moved; re-read and retry
    }
    if (!updateRes.ok) { const b = await updateRes.text(); logUpload('error', 'pushEntries.refUpdate.httpError', { status: updateRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${updateRes.status}: ${b.slice(0, 300)}`); }
    progress?.pct?.(1.0);
    progress?.status?.('Commit pushed ✓');
    logUpload('info', 'pushEntries.done', { commitSha: newCommitSha });
    return;
  }
  logUpload('error', 'pushEntries.exhaustedRetries', {});
  throw new Error('Failed to push after 10 attempts (ref kept moving — try again in a minute)');
}

/**
 * Upload one or more comic files to comics-source/ in a single atomic commit.
 * Large files are transparently split into 15 MB .partNNN chunks.
 */
export async function commitComicsToRepo(
  files: File[],
  progress?: UploadProgress | ((pct: number) => void),
): Promise<void> {
  // Backwards compat: allow a plain (pct) => void callback.
  const prog: UploadProgress = typeof progress === 'function'
    ? { pct: progress }
    : (progress ?? {});

  const t0 = Date.now();
  logUpload('info', 'commitComicsToRepo.start', {
    fileCount: files.length,
    files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    chunkSize: CHUNK_SIZE,
  });

  // ✨ Fast-fail auth check BEFORE we spend minutes uploading a megabyte chunk
  // on a slow connection only to discover the token is wrong. ~1 KB / ~1 s.
  prog.status?.('Checking GitHub authentication…');
  await preflightAuth();

  prog.status?.(`Preparing ${files.length} file${files.length === 1 ? '' : 's'}…`);

  // Build the full list of (path, data) entries, expanding large files into chunks
  const entryDefs: Array<{ path: string; data: Blob }> = [];
  for (const file of files) {
    if (file.size <= CHUNK_SIZE) {
      entryDefs.push({ path: `comics-source/${file.name}`, data: file });
    } else {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      logUpload('info', 'commitComicsToRepo.chunking', { name: file.name, size: file.size, totalChunks });
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        entryDefs.push({
          path: `comics-source/${file.name}.part${String(i + 1).padStart(3, '0')}`,
          data: file.slice(start, Math.min(start + CHUNK_SIZE, file.size)),
        });
      }
    }
  }
  logUpload('info', 'commitComicsToRepo.entriesBuilt', { count: entryDefs.length, paths: entryDefs.map(e => e.path) });

  // Upload all blobs first (content-addressed, no branch locking, no race condition)
  const total = entryDefs.length;
  const entries: Array<{ path: string; sha: string }> = [];
  try {
    for (let i = 0; i < total; i++) {
      const sha = await uploadBlob(entryDefs[i].data, entryDefs[i].path, i + 1, total, {
        // Per-chunk byte progress is forwarded as a status string. The overall
        // pct only ticks once per completed chunk (XHR upload-progress is
        // per-request, not per-pipeline) — the status string fills the gap.
        status: prog.status,
      });
      entries.push({ path: entryDefs[i].path, sha });
      prog.pct?.((i + 1) / total * 0.88);
      prog.status?.(`Chunk ${i + 1} of ${total} uploaded ✓`);
    }
  } catch (e) {
    logUpload('error', 'commitComicsToRepo.blobUploadFailed', { uploadedSoFar: entries.length, totalEntries: total, error: e });
    throw e;
  }

  // ONE commit + ONE PATCH for everything
  const msg = files.length === 1
    ? `add comic: ${files[0].name}`
    : `add comics: ${files.map(f => f.name).join(', ')}`;
  try {
    await pushEntries(entries, msg, {
      pct: (p) => prog.pct?.(0.88 + p * 0.12),
      status: prog.status,
    });
  } catch (e) {
    logUpload('error', 'commitComicsToRepo.pushFailed', { error: e });
    throw e;
  }
  logUpload('info', 'commitComicsToRepo.done', { ms: Date.now() - t0 });
}

