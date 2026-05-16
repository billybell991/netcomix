import { useEffect, useState } from "react";
import { latestScanRun, triggerScan, type WorkflowRun } from "../github-actions";

interface Props {
  onBack: () => void;
  onOpenSetup: () => void;
}

export function AdminView({ onBack, onOpenSetup }: Props) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // Stop polling after 5 minutes of admin-tab being open to spare battery / API quota
      if (Date.now() - started > 5 * 60 * 1000) {
        window.clearInterval(t);
        return;
      }
      refresh();
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  const onScan = async () => {
    setBusy(true);
    setError(null);
    try {
      await triggerScan();
      // Give GH a moment to register the run
      setTimeout(refresh, 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusColor =
    run?.conclusion === "success" ? "#4caf50"
    : run?.conclusion === "failure" ? "#e53935"
    : run?.status === "in_progress" || run?.status === "queued" ? "#ffb300"
    : "#888";

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
            disabled={busy}
            data-testid="scan-btn"
            style={{ background: "#1f6feb", color: "#fff", border: "none", padding: "10px 16px" }}
          >
            {busy ? "Triggering…" : "Scan now"}
          </button>
        </section>

        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#ddd" }}>Latest run</h2>
          {error && <pre data-testid="admin-error" style={{ color: "#e53935" }}>{error}</pre>}
          {!run && !error && <p style={{ color: "#666" }}>No scans yet.</p>}
          {run && (
            <div data-testid="admin-run" style={{ background: "#111", padding: 12, borderRadius: 8, border: "1px solid #333" }}>
              <div>
                <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 6, background: statusColor, marginRight: 8 }} />
                <strong>{run.status}</strong>
                {run.conclusion && <> — {run.conclusion}</>}
              </div>
              <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>{run.created_at}</div>
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
