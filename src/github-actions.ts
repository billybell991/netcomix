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
const CHUNK_SIZE = 15 * 1024 * 1024; // 15 MB raw → ~20 MB base64, well under GitHub's ~40 MB API limit

/** Upload a single Blob (or File slice) to a path in the repo, with retry on 422. */
async function commitBlobToPath(
  data: Blob,
  repoPath: string,
  message: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();
  const base = `${GH_API}/repos/${ghOwner}/${ghRepo}`;

  // 1. Read as base64
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total * 0.3); };
    reader.onload = () => { onProgress?.(0.35); resolve((reader.result as string).split(',')[1]); };
    reader.onerror = () => reject(new Error(`Failed to read data for ${repoPath}`));
    reader.readAsDataURL(data);
  });

  // 2. Create blob
  const blobRes = await fetch(`${base}/git/blobs`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: base64, encoding: 'base64' }),
  });
  if (!blobRes.ok) { const b = await blobRes.text(); throw new Error(`GitHub ${blobRes.status}: ${b.slice(0, 300)}`); }
  const { sha: blobSha } = await blobRes.json() as { sha: string };
  onProgress?.(0.6);

  // 3–6: build tree+commit+ref — retry on 422 with backoff (concurrent CI pushes)
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 + attempt * 1000));

    const refRes = await fetch(`${base}/git/ref/heads/main`, { headers: authHeaders() });
    if (!refRes.ok) { const b = await refRes.text(); throw new Error(`GitHub ${refRes.status}: ${b.slice(0, 300)}`); }
    const { object: { sha: headSha } } = await refRes.json() as { object: { sha: string } };

    const commitRes = await fetch(`${base}/git/commits/${headSha}`, { headers: authHeaders() });
    if (!commitRes.ok) { const b = await commitRes.text(); throw new Error(`GitHub ${commitRes.status}: ${b.slice(0, 300)}`); }
    const { tree: { sha: treeSha } } = await commitRes.json() as { tree: { sha: string } };

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: treeSha, tree: [{ path: repoPath, mode: '100644', type: 'blob', sha: blobSha }] }),
    });
    if (!treeRes.ok) { const b = await treeRes.text(); throw new Error(`GitHub ${treeRes.status}: ${b.slice(0, 300)}`); }
    const { sha: newTreeSha } = await treeRes.json() as { sha: string };
    onProgress?.(0.8);

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
    if (updateRes.status === 422 && attempt < 4) continue;
    if (!updateRes.ok) { const b = await updateRes.text(); throw new Error(`GitHub ${updateRes.status}: ${b.slice(0, 300)}`); }
    onProgress?.(1.0);
    return;
  }
  throw new Error('Failed to push after 5 attempts (ref kept moving — a CI job may be running, try again in a minute)');
}

/**
 * Commit a CBR/CBZ to comics-source/. Files ≤ 15 MB are committed in one shot;
 * larger files are split into 15 MB .part001/.part002/… chunks that scan.yml reassembles.
 */
export async function commitComicToRepo(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  if (file.size <= CHUNK_SIZE) {
    await commitBlobToPath(file, `comics-source/${file.name}`, `add comic: ${file.name}`, onProgress);
  } else {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
      const partName = `${file.name}.part${String(i + 1).padStart(3, '0')}`;
      const chunkProg = (pct: number) => onProgress?.((i + pct) / totalChunks);
      await commitBlobToPath(chunk, `comics-source/${partName}`,
        `add comic part ${i + 1}/${totalChunks}: ${file.name}`, chunkProg);
    }
  }
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
