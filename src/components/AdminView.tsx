import { useEffect, useRef, useState } from "react";
import { latestScanRun, triggerScan, type WorkflowRun } from "../github-actions";
import { isGithubConfigured, isApiConfigured } from "../config";
import { apiAdminIssues, type AdminIssue } from "../api";

interface Props {
  onBack: () => void;
  onOpenSetup: () => void;
}

function useElapsed(startedAt: string | null): string {
  const [, setTick] = useState(0);
  const ref = useRef<number | null>(null);
  useEffect(() => {
    if (!startedAt) return;
    ref.current = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => { if (ref.current != null) window.clearInterval(ref.current); };
  }, [startedAt]);
  if (!startedAt) return "";
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function statusLabel(run: WorkflowRun | null): string {
  if (!run) return "";
  if (run.status === "queued") return "Queued — waiting for a runner…";
  if (run.status === "in_progress") return "Running…";
  if (run.conclusion === "success") return "Completed successfully";
  if (run.conclusion === "failure") return "Failed";
  if (run.conclusion === "cancelled") return "Cancelled";
  return run.status;
}

export function AdminView({ onBack, onOpenSetup }: Props) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const triggeredId = useRef<number | null>(null);

  // Issues list for re-detect helper
  const [adminIssues, setAdminIssues] = useState<AdminIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const ghConfigured = isGithubConfigured();
  const apiReady = isApiConfigured();
  const isActive = run && (run.status === "queued" || run.status === "in_progress");
  const elapsed = useElapsed(isActive ? run.created_at : null);

  const refresh = async () => {
    try {
      setRun(await latestScanRun());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const started = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - started > 5 * 60 * 1000) { window.clearInterval(t); return; }
      refresh();
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  // Load issues list if API is configured
  useEffect(() => {
    if (!apiReady) return;
    apiAdminIssues()
      .then(setAdminIssues)
      .catch((e) => setIssuesError(String(e)));
  }, [apiReady]);

  const onScan = async () => {
    setDispatching(true);
    setError(null);
    try {
      await triggerScan();
      // Poll quickly for a few seconds so the new run appears promptly
      let attempts = 0;
      const poll = window.setInterval(async () => {
        attempts++;
        const r = await latestScanRun().catch(() => null);
        if (r) {
          setRun(r);
          triggeredId.current = r.id;
        }
        if (attempts >= 6) window.clearInterval(poll);
      }, 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setDispatching(false);
    }
  };

  const statusColor =
    run?.conclusion === "success" ? "#4caf50"
    : run?.conclusion === "failure" ? "#e53935"
    : run?.status === "in_progress" ? "#ffb300"
    : run?.status === "queued" ? "#64b5f6"
    : "#888";

  const buttonBusy = !ghConfigured || dispatching || (run?.status === "queued") || (run?.status === "in_progress");

  return (
    <div className="shell" data-testid="admin-view">
      <div className="shell-header">
        <button className="back-btn" data-testid="back-btn" onClick={onBack} aria-label="Back">
          ← Back
        </button>
        <h1>Admin</h1>
      </div>
      <div className="shell-body" style={{ maxWidth: 640, margin: "0 auto" }}>

        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Scan Drive folder</h2>
          <p style={{ color: "#aaa" }}>
            Triggers the GitHub Action that downloads new <code>.cbz</code>/<code>.cbr</code> files from
            your Drive folder, extracts panels, and uploads JPEG pages + manifests back to Drive.
          </p>
          <button
            className="back-btn"
            onClick={onScan}
            disabled={buttonBusy}
            data-testid="scan-btn"
            title={!ghConfigured ? "Configure GitHub owner, repo, and token in Setup first" : undefined}
            style={{ background: buttonBusy ? "#555" : "#1f6feb", color: "#fff", border: "none", padding: "10px 16px", transition: "background 0.2s" }}
          >
            {dispatching && <span className="nc-spinner" />}
            {dispatching ? "Triggering…" : (buttonBusy && ghConfigured) ? "In progress…" : "Scan now"}
          </button>
          {!ghConfigured && (
            <p style={{ color: "#888", fontSize: 13, marginTop: 8 }}>
              GitHub not configured — add your owner, repo, and token in{" "}
              <button
                style={{ background: "none", border: "none", color: "#1f6feb", cursor: "pointer", padding: 0, fontSize: 13 }}
                onClick={onOpenSetup}
              >Setup</button>.
            </p>
          )}
        </section>

        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Latest run</h2>
          {error && <pre data-testid="admin-error" style={{ color: "#e53935", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error}</pre>}
          {!run && !error && <p style={{ color: "#666" }}>{ghConfigured ? "No scans yet." : "Configure GitHub to see scan history."}</p>}
          {run && (
            <div
              data-testid="admin-run"
              style={{
                background: "#111",
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${isActive ? statusColor : "#333"}`,
                transition: "border-color 0.4s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className={isActive ? "nc-dot-pulse" : undefined}
                  style={{ display: "inline-block", width: 12, height: 12, borderRadius: 6, background: statusColor, flexShrink: 0 }}
                />
                <strong style={{ color: statusColor }}>{statusLabel(run)}</strong>
                {isActive && elapsed && (
                  <span style={{ color: "#888", fontSize: 12, marginLeft: "auto" }}>{elapsed}</span>
                )}
              </div>

              {/* indeterminate progress bar while active */}
              {isActive && (
                <div className="nc-progress-bar-track">
                  <div className="nc-progress-bar-fill indeterminate" style={{ background: statusColor }} />
                </div>
              )}

              <div style={{ color: "#666", fontSize: 12, marginTop: 8 }}>
                Started {new Date(run.created_at).toLocaleString()}
              </div>
              <a href={run.html_url} target="_blank" rel="noreferrer" style={{ color: "#1f6feb", fontSize: 13 }}>
                View on GitHub →
              </a>
            </div>
          )}
        </section>

        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Issues — re-detect helper</h2>
          <p style={{ color: "#aaa", fontSize: 13 }}>
            To re-detect panels for a single issue, copy its command and run it in your terminal
            (requires env vars set locally).
          </p>
          {!apiReady && <p style={{ color: "#666", fontSize: 13 }}>Configure API URL in Setup to see the issue list.</p>}
          {issuesError && <p style={{ color: "#e53935", fontSize: 13 }}>{issuesError}</p>}
          {apiReady && !adminIssues && !issuesError && <p style={{ color: "#666", fontSize: 13 }}>Loading…</p>}
          {adminIssues && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 360, overflowY: "auto" }}>
              {adminIssues.map((iss) => (
                <div key={iss.id} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  background: "#111", borderRadius: 6, padding: "6px 10px",
                  border: "1px solid #222",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#ccc", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {iss.seriesTitle} — {iss.title}
                    </div>
                    <div style={{ color: "#666", fontSize: 11 }}>{iss.pageCount} pages</div>
                  </div>
                  <button
                    style={{
                      background: copiedId === iss.id ? "rgba(76,175,80,0.25)" : "rgba(255,255,255,0.08)",
                      border: `1px solid ${copiedId === iss.id ? "#4caf50" : "rgba(255,255,255,0.18)"}`,
                      borderRadius: 5, color: copiedId === iss.id ? "#4caf50" : "#aaa",
                      fontSize: 11, padding: "4px 8px", cursor: "pointer", whiteSpace: "nowrap",
                      transition: "all 0.2s",
                    }}
                    title={`python harvester/redetect_all.py --issue ${iss.id}`}
                    onClick={() => {
                      navigator.clipboard.writeText(`python harvester/redetect_all.py --issue ${iss.id}`);
                      setCopiedId(iss.id);
                      setTimeout(() => setCopiedId(null), 2000);
                    }}
                  >
                    {copiedId === iss.id ? "✓ Copied" : "⎘ Re-detect"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <button className="back-btn" onClick={onOpenSetup} data-testid="open-setup">
            Reconfigure setup…
          </button>
        </section>
      </div>
    </div>
  );
}

