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
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function triggerScan(): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/scan.yml/dispatches`,
    {
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
    { headers: authHeaders() }
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

const CHUNK_SIZE = 15 * 1024 * 1024; // 15 MB raw → ~20 MB base64, well within the ~100 MB API limit

/** Upload raw bytes to the Git Blobs API and return the blob sha. */
async function uploadBlob(data: Blob, label?: string): Promise<string> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  const url = `${base}/git/blobs`;
  const t0 = Date.now();
  logUpload('info', 'uploadBlob.start', { label, bytes: data.size, type: data.type, url });

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

  // 2) Fetch /git/blobs. This is where "TypeError: failed to fetch" lands —
  //    capture the exception name+message+cause+onLine state.
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: base64, encoding: 'base64' }),
    });
  } catch (e) {
    logUpload('error', 'uploadBlob.fetchThrew', {
      label, url, bytes: data.size, base64Len: base64.length, ms: Date.now() - t0,
      onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
      error: e,
    });
    throw e;
  }

  // 3) Log response metadata before reading the body — even on 5xx the
  //    rate-limit / request-id headers are diagnostic.
  const rlRemaining = res.headers.get('x-ratelimit-remaining');
  const rlReset = res.headers.get('x-ratelimit-reset');
  const reqId = res.headers.get('x-github-request-id');
  logUpload(res.ok ? 'debug' : 'warn', 'uploadBlob.response', {
    label, status: res.status, ok: res.ok, ms: Date.now() - t0,
    rateLimitRemaining: rlRemaining, rateLimitReset: rlReset, requestId: reqId,
  });

  if (!res.ok) {
    const b = await res.text();
    logUpload('error', 'uploadBlob.httpError', { label, status: res.status, body: b.slice(0, 500), requestId: reqId });
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
    const res = await fetch(url, init);
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
  onProgress?: (pct: number) => void,
): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  logUpload('info', 'pushEntries.start', { entryCount: entries.length, message });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
    logUpload('info', 'pushEntries.attempt', { attempt: attempt + 1 });

    const refRes = await loggedFetch('pushEntries.ref', `${base}/git/ref/heads/main`, { headers: authHeaders() });
    if (!refRes.ok) { const b = await refRes.text(); logUpload('error', 'pushEntries.ref.httpError', { status: refRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${refRes.status}: ${b.slice(0, 300)}`); }
    const { object: { sha: headSha } } = await refRes.json() as { object: { sha: string } };

    const commitRes = await loggedFetch('pushEntries.commitRead', `${base}/git/commits/${headSha}`, { headers: authHeaders() });
    if (!commitRes.ok) { const b = await commitRes.text(); logUpload('error', 'pushEntries.commitRead.httpError', { status: commitRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${commitRes.status}: ${b.slice(0, 300)}`); }
    const { tree: { sha: treeSha } } = await commitRes.json() as { tree: { sha: string } };

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

    const newCommitRes = await loggedFetch('pushEntries.commitCreate', `${base}/git/commits`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: newTreeSha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) { const b = await newCommitRes.text(); logUpload('error', 'pushEntries.commitCreate.httpError', { status: newCommitRes.status, body: b.slice(0, 300) }); throw new Error(`GitHub ${newCommitRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newCommitSha } = await newCommitRes.json() as { sha: string };

    onProgress?.(0.95);
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
    onProgress?.(1.0);
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
  onProgress?: (pct: number) => void,
): Promise<void> {
  const t0 = Date.now();
  logUpload('info', 'commitComicsToRepo.start', {
    fileCount: files.length,
    files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    chunkSize: CHUNK_SIZE,
  });

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
      const label = `${entryDefs[i].path} (${i + 1}/${total})`;
      const sha = await uploadBlob(entryDefs[i].data, label);
      entries.push({ path: entryDefs[i].path, sha });
      onProgress?.((i + 1) / total * 0.88);
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
    await pushEntries(entries, msg, (pct) => onProgress?.(0.88 + pct * 0.12));
  } catch (e) {
    logUpload('error', 'commitComicsToRepo.pushFailed', { error: e });
    throw e;
  }
  logUpload('info', 'commitComicsToRepo.done', { ms: Date.now() - t0 });
}

