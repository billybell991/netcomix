import { useState } from "react";
import { EMPTY_CONFIG, getConfig, saveConfig, type NetComixConfig } from "../config";

interface Props {
  onSaved: () => void;
  onSkip?: () => void;
}

export function SetupView({ onSaved, onSkip }: Props) {
  const [cfg, setCfg] = useState<NetComixConfig>(() => ({ ...EMPTY_CONFIG, ...getConfig() }));
  const upd = (k: keyof NetComixConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg((c) => ({ ...c, [k]: e.target.value.trim() }));

  const driveValid = Boolean(cfg.driveFolderId && cfg.driveApiKey);
  const ghValid = Boolean(cfg.ghOwner && cfg.ghRepo && cfg.ghToken);
  const anyValid = driveValid || ghValid || (!cfg.driveFolderId && !cfg.driveApiKey && !cfg.ghOwner && !cfg.ghRepo && !cfg.ghToken);
  const error =
    !driveValid && (cfg.driveFolderId || cfg.driveApiKey) ? "Drive needs BOTH folder ID and API key."
    : !ghValid && (cfg.ghOwner || cfg.ghRepo || cfg.ghToken) ? "GitHub needs owner, repo, AND token."
    : null;

  const save = () => {
    if (error) return;
    saveConfig(cfg);
    onSaved();
  };

  return (
    <div className="shell" data-testid="setup-view">
      <div className="shell-header">
        <h1>NetComix Setup</h1>
      </div>
      <div className="shell-body" style={{ maxWidth: 640, margin: "0 auto" }}>
        <p style={{ color: "#aaa", marginBottom: 16 }}>
          Point NetComix at a Google Drive folder. See <code>SETUP.md</code> in the repo for the
          one-time GCP / Drive setup walkthrough.
        </p>

        <fieldset style={{ border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <legend style={{ padding: "0 6px", color: "#ddd" }}>Railway API (primary)</legend>
          <Field label="API URL" value={cfg.apiUrl} onChange={upd("apiUrl")}
            hint="Your Railway backend URL, e.g. https://netcomix-api.railway.app" />
          <Field label="Access code" value={cfg.accessCode} onChange={upd("accessCode")} type="password"
            hint="The ACCESS_CODE env var you set on the Railway service" />
        </fieldset>

        <fieldset style={{ border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <legend style={{ padding: "0 6px", color: "#ddd" }}>Google Drive (read)</legend>
          <Field label="Drive folder ID" value={cfg.driveFolderId} onChange={upd("driveFolderId")}
            hint="From your Drive folder URL: drive.google.com/drive/folders/<THIS_PART>" />
          <Field label="Drive API key" value={cfg.driveApiKey} onChange={upd("driveApiKey")} type="password"
            hint="Google Cloud → APIs & Services → Credentials → Create API key (restrict to Drive API)" />
        </fieldset>

        <fieldset style={{ border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <legend style={{ padding: "0 6px", color: "#ddd" }}>GitHub (scan trigger)</legend>
          <Field label="GitHub owner" value={cfg.ghOwner} onChange={upd("ghOwner")} hint="e.g. billybell991" />
          <Field label="GitHub repo" value={cfg.ghRepo} onChange={upd("ghRepo")} hint="e.g. netcomix" />
          <Field label="Personal Access Token" value={cfg.ghToken} onChange={upd("ghToken")} type="password"
            hint="github.com/settings/tokens → Fine-grained → Actions: Read+Write on this repo" />
        </fieldset>

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", alignItems: "center" }}>
          {error && <span data-testid="setup-error" style={{ color: "#e53935", marginRight: "auto" }}>{error}</span>}
          {onSkip && (
            <button className="back-btn" onClick={onSkip} data-testid="setup-skip">
              Skip (use demo)
            </button>
          )}
          <button className="btn-primary" onClick={save} data-testid="setup-save" disabled={!!error || !anyValid}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, hint, type = "text",
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  hint?: string;
  type?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ color: "#ddd", marginBottom: 4 }}>{label}</div>
      <input
        type={type}
        value={value}
        onChange={onChange}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%",
          padding: "8px 10px",
          background: "#111",
          color: "#fff",
          border: "1px solid #333",
          borderRadius: 6,
          fontFamily: "monospace",
        }}
      />
      {hint && <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}
