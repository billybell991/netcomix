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

  const ghValid = Boolean(cfg.ghOwner && cfg.ghRepo && cfg.ghToken);
  const anyValid = ghValid || (!cfg.ghOwner && !cfg.ghRepo && !cfg.ghToken);
  const error =
    !ghValid && (cfg.ghOwner || cfg.ghRepo || cfg.ghToken) ? "GitHub needs owner, repo, AND token."
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

        <fieldset style={{ border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <legend style={{ padding: "0 6px", color: "#ddd" }}>GitHub (scan trigger)</legend>
          <Field label="GitHub owner" value={cfg.ghOwner} onChange={upd("ghOwner")} hint="e.g. billybell991" />
          <Field label="GitHub repo" value={cfg.ghRepo} onChange={upd("ghRepo")} hint="e.g. netcomix" />
          <Field label="Personal Access Token" value={cfg.ghToken} onChange={upd("ghToken")} type="password"
            hint="github.com/settings/tokens → Fine-grained → Contents + Actions: Read+Write on this repo" />
        </fieldset>

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", alignItems: "center" }}>
          {error && <span data-testid="setup-error" style={{ color: "#e53935", marginRight: "auto" }}>{error}</span>}
          {onSkip && (
            <button className="back-btn" onClick={onSkip} data-testid="setup-skip">
              Skip
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
