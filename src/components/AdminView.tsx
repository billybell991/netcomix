import { useEffect, useRef, useState } from "react";
import { latestScanRun, triggerScan, commitComicToRepo, type WorkflowRun } from "../github-actions";
import { isGithubConfigured } from "../config";

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

  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ghConfigured = isGithubConfigured();
  const isActive = run && (run.status === "queued" || run.status === "in_progress");
  const elapsed = useElapsed(isActive ? run.created_at : null);

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    setUploadFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...picked.filter((f) => !existing.has(f.name))];
    });
    e.target.value = "";
  };

  const onUpload = async () => {
    if (!uploadFiles.length) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setUploadDone(false);
    const n = uploadFiles.length;
    try {
      for (let i = 0; i < n; i++) {
        await commitComicToRepo(uploadFiles[i], (pct) => setUploadProgress((i + pct) / n));
      }
      setUploadDone(true);
      setUploadFiles([]);
      await triggerScan();
      await refresh();
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

  const statusColor =
    run?.conclusion === "success" ? "#4caf50"
    : run?.conclusion === "failure" ? "#e53935"
    : run?.status === "in_progress" ? "#ffb300"
    : run?.status === "queued" ? "#64b5f6"
    : "#888";

  return (
    <div className="shell" data-testid="admin-view">
      <div className="shell-header">
        <button className="back-btn" data-testid="back-btn" onClick={onBack} aria-label="Back">
          ← Back
        </button>
        <h1>Admin</h1>
      </div>
      <div className="shell-body" style={{ width: "100%", maxWidth: 640, alignSelf: "center" }}>

        {/* ── Upload Comics ─────────────────────────────────────── */}
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Upload comics</h2>
          <p style={{ color: "#aaa", fontSize: 13 }}>
            Drop <code>.cbz</code> / <code>.cbr</code> files here. They'll be committed to the
            repo and processed by the GitHub Action automatically.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept=".cbz,.cbr,.zip,.rar"
            multiple
            style={{ display: "none" }}
            onChange={onFilePick}
          />

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

          {uploadFiles.length > 0 && (
            <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {uploadFiles.map((f) => (
                <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 8, background: "#111", borderRadius: 6, padding: "5px 10px", fontSize: 12 }}>
                  <span style={{ flex: 1, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span style={{ color: "#666", flexShrink: 0 }}>
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </span>
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

          {uploading && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ height: 4, background: "#222", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${Math.round(uploadProgress * 100)}%`, background: "#1f6feb", borderRadius: 2, transition: "width 0.2s" }} />
              </div>
              <div style={{ color: "#888", fontSize: 11, marginTop: 4 }}>{Math.round(uploadProgress * 100)}% committed</div>
            </div>
          )}

          {uploadError && <p style={{ color: "#e53935", fontSize: 13, margin: "6px 0" }}>{uploadError}</p>}
          {uploadDone && <p style={{ color: "#4caf50", fontSize: 13, margin: "6px 0" }}>✓ Committed — scan triggered</p>}

          <button
            className="btn-primary"
            onClick={onUpload}
            disabled={!uploadFiles.length || uploading || !ghConfigured}
            style={{ marginTop: 4 }}
          >
            {uploading ? "Committing…" : `Upload${uploadFiles.length > 0 ? ` (${uploadFiles.length})` : ""} & Scan`}
          </button>
          {!ghConfigured && <p style={{ color: "#888", fontSize: 12, marginTop: 6 }}>Configure GitHub in Setup to enable uploads.</p>}
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

        <section>
          <button className="back-btn" onClick={onOpenSetup} data-testid="open-setup">
            Reconfigure setup…
          </button>
        </section>
      </div>
    </div>
  );
}

