// User-supplied config: Drive folder + API key + GitHub repo + PAT.
// Stored in localStorage so first-run setup is one-time per browser.

export interface NetComixConfig {
  driveFolderId: string;
  driveApiKey: string;
  ghOwner: string;
  ghRepo: string;
  ghToken: string; // Personal Access Token with `workflow` scope
}

const KEY = "netcomix.config.v1";

export const EMPTY_CONFIG: NetComixConfig = {
  driveFolderId: "",
  driveApiKey: "",
  ghOwner: "",
  ghRepo: "",
  ghToken: "",
};

export function getConfig(): NetComixConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_CONFIG };
    return { ...EMPTY_CONFIG, ...JSON.parse(raw) };
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

/** Drive is configured (read-side: PWA can list/read). */
export function isDriveConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.driveFolderId && cfg.driveApiKey);
}

/** GitHub is configured (admin-side: PWA can trigger Scan). */
export function isGithubConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.ghOwner && cfg.ghRepo && cfg.ghToken);
}
