import { useEffect, useRef, useState } from "react";
import { latestScanRun, triggerScan, triggerRedetect, latestRedetectRun, type WorkflowRun } from "../github-actions";
import { isGithubConfigured, isApiConfigured } from "../config";
import { apiAdminIssues, apiStageFiles, type AdminIssue } from "../api";

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

  // Issues list + re-detect
  const [adminIssues, setAdminIssues] = useState<AdminIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [redetectingId, setRedetectingId] = useState<string | null>(null);
  const [redetectDoneId, setRedetectDoneId] = useState<string | null>(null);
  const [redetectErrorId, setRedetectErrorId] = useState<string | null>(null);
  const [redetectRun, setRedetectRun] = useState<WorkflowRun | null>(null);

  const ghConfigured = isGithubConfigured();
  const apiReady = isApiConfigured();
  const isActive = run && (run.status === "queued" || run.status === "in_progress");
  const elapsed = useElapsed(isActive ? run.created_at : null);

  // Upload state
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    setUploadFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...picked.filter((f) => !existing.has(f.name))];
    });
    e.target.value = "";
  };

  const onUploadAndScan = async () => {
    if (!uploadFiles.length) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setUploadDone(false);
    try {
      await apiStageFiles(uploadFiles, setUploadProgress);
      setUploadDone(true);
      setUploadFiles([]);
      // Auto-trigger the scan so GitHub Actions picks up the staged files
      if (ghConfigured) {
        await triggerScan();
        await refresh();
      }
    } catch (e) {
      setUploadError(String(e));
    } finally {
      setUploading(false);
    }
  };

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

  const onRedetect = async (issueId: string) => {
    if (redetectingId) return;
    setRedetectingId(issueId);
    setRedetectDoneId(null);
    setRedetectErrorId(null);
    try {
      await triggerRedetect(issueId);
      // Poll until the run appears and completes
      let attempts = 0;
      const poll = window.setInterval(async () => {
        attempts++;
        const r = await latestRedetectRun().catch(() => null);
        if (r) setRedetectRun(r);
        if (r && r.status === "completed") {
          window.clearInterval(poll);
          setRedetectingId(null);
          if (r.conclusion === "success") {
            setRedetectDoneId(issueId);
            setTimeout(() => setRedetectDoneId(null), 4000);
          } else {
            setRedetectErrorId(issueId);
            setTimeout(() => setRedetectErrorId(null), 6000);
          }
        }
        if (attempts >= 120) { // 10 min timeout
          window.clearInterval(poll);
          setRedetectingId(null);
        }
      }, 5000);
    } catch (e) {
      setRedetectErrorId(issueId);
      setRedetectingId(null);
      setTimeout(() => setRedetectErrorId(null), 6000);
    }
  };

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

        {/* ── Upload Comics ─────────────────────────────────────── */}
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Upload comics</h2>
          <p style={{ color: "#aaa", fontSize: 13 }}>
            Drop <code>.cbz</code> / <code>.cbr</code> files here. They'll be staged then processed
            by the GitHub Action automatically.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept=".cbz,.cbr,.zip,.rar"
            multiple
            style={{ display: "none" }}
            onChange={onFilePick}
          />

          {/* Drop zone / pick button */}
          <div
            style={{
              border: "2px dashed #444", borderRadius: 8, padding: "20px 16px",
              textAlign: "center", cursor: "pointer", marginBottom: 8,
              background: "#0d0d0d", color: "#888", fontSize: 13,
              transition: "border-color 0.2s",
            }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#1f6feb"; }}
            onDragLeave={(e) => { e.currentTarget.style.borderColor = "#444"; }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.style.borderColor = "#444";
              const dropped = Array.from(e.dataTransfer.files).filter((f) =>
                [".cbz", ".cbr", ".zip", ".rar"].some((ext) => f.name.toLowerCase().endsWith(ext))
              );
              setUploadFiles((prev) => {
                const existing = new Set(prev.map((f) => f.name));
                return [...prev, ...dropped.filter((f) => !existing.has(f.name))];
              });
            }}
          >
            Click to pick or drag &amp; drop .cbz / .cbr files
          </div>

          {/* File list */}
          {uploadFiles.length > 0 && (
            <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {uploadFiles.map((f) => (
                <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 8, background: "#111", borderRadius: 6, padding: "5px 10px", fontSize: 12 }}>
                  <span style={{ flex: 1, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span style={{ color: "#666", flexShrink: 0 }}>{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  {!uploading && (
                    <button
                      onClick={() => setUploadFiles((prev) => prev.filter((x) => x.name !== f.name))}
                      style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "0 2px" }}
                    >✕</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Upload progress */}
          {uploading && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ height: 4, background: "#222", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${Math.round(uploadProgress * 100)}%`, background: "#1f6feb", borderRadius: 2, transition: "width 0.2s" }} />
              </div>
              <div style={{ color: "#888", fontSize: 11, marginTop: 4 }}>{Math.round(uploadProgress * 100)}% uploaded</div>
            </div>
          )}

          {uploadError && <p style={{ color: "#e53935", fontSize: 13, margin: "6px 0" }}>{uploadError}</p>}
          {uploadDone && <p style={{ color: "#4caf50", fontSize: 13, margin: "6px 0" }}>✓ Uploaded — scan triggered</p>}

          <button
            className="btn-primary"
            onClick={onUploadAndScan}
            disabled={!uploadFiles.length || uploading || !apiReady}
            style={{ marginTop: 4 }}
          >
            {uploading ? "Uploading…" : `Upload${uploadFiles.length > 0 ? ` (${uploadFiles.length})` : ""} & Scan`}
          </button>
          {!apiReady && <p style={{ color: "#888", fontSize: 12, marginTop: 6 }}>Configure API URL in Setup to enable uploads.</p>}
          {!ghConfigured && apiReady && <p style={{ color: "#888", fontSize: 12, marginTop: 6 }}>⚠ GitHub not configured — files will be staged but scan won't auto-trigger.</p>}
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
          <h2 style={{ color: "#ddd" }}>Re-detect panels</h2>
          {!apiReady && <p style={{ color: "#666", fontSize: 13 }}>Configure API URL in Setup to see the issue list.</p>}
          {!ghConfigured && apiReady && <p style={{ color: "#888", fontSize: 13 }}>Configure GitHub in Setup to enable re-detect.</p>}
          {issuesError && <p style={{ color: "#e53935", fontSize: 13 }}>{issuesError}</p>}
          {apiReady && !adminIssues && !issuesError && <p style={{ color: "#666", fontSize: 13 }}>Loading…</p>}
          {adminIssues && adminIssues.length === 0 && <p style={{ color: "#666", fontSize: 13 }}>No issues yet — upload some comics first.</p>}
          {redetectRun && redetectingId && (
            <div style={{ background: "#111", border: "1px solid #333", borderRadius: 6, padding: "6px 10px", marginBottom: 8, fontSize: 12, color: "#aaa" }}>
              Re-detect job: <span style={{ color: redetectRun.status === "completed" && redetectRun.conclusion === "success" ? "#4caf50" : redetectRun.status === "completed" ? "#e53935" : "#ffb300" }}>
                {redetectRun.status === "completed" ? redetectRun.conclusion : redetectRun.status}
              </span>
              {" "}<a href={redetectRun.html_url} target="_blank" rel="noreferrer" style={{ color: "#1f6feb" }}>View →</a>
            </div>
          )}
          {adminIssues && adminIssues.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 400, overflowY: "auto" }}>
              {adminIssues.map((iss) => {
                const isRunning = redetectingId === iss.id;
                const isDone = redetectDoneId === iss.id;
                const isErr = redetectErrorId === iss.id;
                return (
                  <div key={iss.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    background: "#111", borderRadius: 6, padding: "8px 10px",
                    border: `1px solid ${isDone ? "#4caf5055" : isErr ? "#e5393555" : "#222"}`,
                    transition: "border-color 0.3s",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#ccc", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {iss.seriesTitle} — {iss.title}
                      </div>
                      <div style={{ color: "#555", fontSize: 11 }}>{iss.pageCount} pages · {iss.id}</div>
                    </div>
                    <button
                      disabled={!ghConfigured || !!redetectingId}
                      onClick={() => onRedetect(iss.id)}
                      style={{
                        background: isDone ? "rgba(76,175,80,0.2)" : isErr ? "rgba(229,57,53,0.2)" : isRunning ? "rgba(255,179,0,0.15)" : "rgba(31,111,235,0.15)",
                        border: `1px solid ${isDone ? "#4caf50" : isErr ? "#e53935" : isRunning ? "#ffb300" : "rgba(31,111,235,0.5)"}`,
                        borderRadius: 5, color: isDone ? "#4caf50" : isErr ? "#e53935" : isRunning ? "#ffb300" : "#60a5fa",
                        fontSize: 11, padding: "5px 10px", cursor: redetectingId ? "default" : "pointer",
                        whiteSpace: "nowrap", minWidth: 80, transition: "all 0.2s",
                      }}
                    >
                      {isRunning && <span className="nc-spinner" />}
                      {isDone ? "✓ Done" : isErr ? "✗ Failed" : isRunning ? "Running…" : "Re-detect"}
                    </button>
                  </div>
                );
              })}
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

