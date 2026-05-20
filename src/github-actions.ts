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
 * Commit a CBR/CBZ archive to comics-source/ in the repo via GitHub Contents API.
 * Requires ghOwner, ghRepo, and ghToken to be configured.
 */
export async function commitComicToRepo(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const { ghOwner, ghRepo } = getConfig();

  // Read and base64-encode via FileReader (handles binary correctly)
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total * 0.35); };
    reader.onload = () => {
      onProgress?.(0.4);
      resolve((reader.result as string).split(',')[1]);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });

  const filePath = `comics-source/${file.name}`;

  // Check if file already exists — need its SHA to update rather than create
  let sha: string | undefined;
  const checkRes = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/contents/${filePath}`,
    { headers: authHeaders() }
  );
  if (checkRes.ok) {
    const existing = (await checkRes.json()) as { sha: string };
    sha = existing.sha;
  }

  onProgress?.(0.5);

  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `add comic: ${file.name}`,
        content: base64,
        ...(sha ? { sha } : {}),
      }),
    }
  );

  onProgress?.(1.0);

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GitHub auth failed (${res.status}) — token needs Contents: Write access on ${ghOwner}/${ghRepo}.`);
    }
    throw new Error(`Commit failed: ${res.status} — ${body.slice(0, 200)}`);
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
