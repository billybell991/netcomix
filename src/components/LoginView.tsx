import { useState } from "react";
import { validateCode } from "../api";
import { getConfig, saveConfig } from "../config";

interface Props {
  onAuthenticated: () => void;
}

export function LoginView({ onAuthenticated }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setChecking(true);
    setError(null);
    try {
      const ok = await validateCode(trimmed);
      if (ok) {
        // Persist code so user doesn't have to enter it again
        const cfg = getConfig();
        saveConfig({ ...cfg, accessCode: trimmed });
        onAuthenticated();
      } else {
        setError("Incorrect access code. Try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="shell"
      data-testid="login-view"
      style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ width: "100%", maxWidth: 360, padding: "0 24px" }}>
        <h1 style={{ textAlign: "center", marginBottom: 32 }}>
          <span className="accent">Net</span>Comix
        </h1>
        <input
          className="search-bar"
          type="password"
          placeholder="Access code"
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          data-testid="access-code-input"
          style={{ marginBottom: 12 }}
        />
        <button
          className="back-btn"
          onClick={submit}
          disabled={checking || !code.trim()}
          data-testid="login-btn"
          style={{
            width: "100%",
            background: checking ? "#555" : "#1f6feb",
            color: "#fff",
            border: "none",
            padding: "10px 16px",
            fontSize: 15,
            borderRadius: 8,
            cursor: checking ? "default" : "pointer",
          }}
        >
          {checking ? "Checking…" : "Enter"}
        </button>
        {error && (
          <p
            data-testid="login-error"
            style={{ color: "#e53935", marginTop: 12, textAlign: "center", fontSize: 14 }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
