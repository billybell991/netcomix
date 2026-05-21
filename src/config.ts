// User-supplied config: GitHub repo + PAT for scan trigger.
// Stored in localStorage so first-run setup is one-time per browser.

export interface NetComixConfig {
  ghOwner: string;
  ghRepo: string;
  ghToken: string; // Personal Access Token with Contents + Actions write access
}
}

const KEY = "netcomix.config.v1";

export const EMPTY_CONFIG: NetComixConfig = {
  ghOwner: "",
  ghRepo: "",
  ghToken: "",
};

export function getConfig(): NetComixConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_CONFIG };
    const stored = JSON.parse(raw) as Partial<NetComixConfig>;
    return { ...EMPTY_CONFIG, ...stored };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function saveConfig(cfg: NetComixConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}

/** GitHub is configured (admin-side: PWA can commit files and trigger Scan). */
export function isGithubConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.ghOwner && cfg.ghRepo && cfg.ghToken);
}
