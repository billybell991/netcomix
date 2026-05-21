// Trigger a GitHub Actions workflow_dispatch and poll its status.

import { getConfig, isGithubConfigured } from "./config";

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
async function uploadBlob(data: Blob): Promise<string> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(data);
  });
  const res = await fetch(`${base}/git/blobs`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: base64, encoding: 'base64' }),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(`GitHub ${res.status}: ${b.slice(0, 300)}`); }
  const { sha } = await res.json() as { sha: string };
  return sha;
}

/** Push a set of pre-uploaded blobs as ONE commit. Retries up to 10× on 422. */
async function pushEntries(
  entries: Array<{ path: string; sha: string }>,
  message: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 + attempt * 2000));

    const refRes = await fetch(`${base}/git/ref/heads/main`, { headers: authHeaders() });
    if (!refRes.ok) { const b = await refRes.text(); throw new Error(`GitHub ${refRes.status}: ${b.slice(0, 300)}`); }
    const { object: { sha: headSha } } = await refRes.json() as { object: { sha: string } };

    const commitRes = await fetch(`${base}/git/commits/${headSha}`, { headers: authHeaders() });
    if (!commitRes.ok) { const b = await commitRes.text(); throw new Error(`GitHub ${commitRes.status}: ${b.slice(0, 300)}`); }
    const { tree: { sha: treeSha } } = await commitRes.json() as { tree: { sha: string } };

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: treeSha,
        tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
      }),
    });
    if (!treeRes.ok) { const b = await treeRes.text(); throw new Error(`GitHub ${treeRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newTreeSha } = await treeRes.json() as { sha: string };

    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: newTreeSha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) { const b = await newCommitRes.text(); throw new Error(`GitHub ${newCommitRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newCommitSha } = await newCommitRes.json() as { sha: string };

    onProgress?.(0.95);
    const updateRes = await fetch(`${base}/git/refs/heads/main`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (updateRes.status === 422 && attempt < 9) continue; // HEAD moved; re-read and retry
    if (!updateRes.ok) { const b = await updateRes.text(); throw new Error(`GitHub ${updateRes.status}: ${b.slice(0, 300)}`); }
    onProgress?.(1.0);
    return;
  }
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
  // Build the full list of (path, data) entries, expanding large files into chunks
  const entryDefs: Array<{ path: string; data: Blob }> = [];
  for (const file of files) {
    if (file.size <= CHUNK_SIZE) {
      entryDefs.push({ path: `comics-source/${file.name}`, data: file });
    } else {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        entryDefs.push({
          path: `comics-source/${file.name}.part${String(i + 1).padStart(3, '0')}`,
          data: file.slice(start, Math.min(start + CHUNK_SIZE, file.size)),
        });
      }
    }
  }

  // Upload all blobs first (content-addressed, no branch locking, no race condition)
  const total = entryDefs.length;
  const entries: Array<{ path: string; sha: string }> = [];
  for (let i = 0; i < total; i++) {
    const sha = await uploadBlob(entryDefs[i].data);
    entries.push({ path: entryDefs[i].path, sha });
    onProgress?.((i + 1) / total * 0.88);
  }

  // ONE commit + ONE PATCH for everything
  const msg = files.length === 1
    ? `add comic: ${files[0].name}`
    : `add comics: ${files.map(f => f.name).join(', ')}`;
  await pushEntries(entries, msg, (pct) => onProgress?.(0.88 + pct * 0.12));
}

export async function triggerRedetect(issueId: string): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/redetect.yml/dispatches`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { issue_id: issueId } }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Re-detect dispatch failed: ${res.status} ${body}`);
  }
}

export async function latestRedetectRun(): Promise<WorkflowRun | null> {
  if (!isGithubConfigured()) return null;
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/redetect.yml/runs?per_page=1`,
    { headers: authHeaders() }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs[0] ?? null;
}
