// Trigger a GitHub Actions workflow_dispatch and poll its status.

import { getConfig } from "./config";

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
  const { ghOwner, ghRepo } = getConfig();
  const res = await fetch(
    `${GH_API}/repos/${ghOwner}/${ghRepo}/actions/workflows/scan.yml/runs?per_page=1`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`List runs failed: ${res.status}`);
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs[0] ?? null;
}
