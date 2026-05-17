// User-supplied config: Drive folder + API key + GitHub repo + PAT.
// Stored in localStorage so first-run setup is one-time per browser.

export interface NetComixConfig {
  driveFolderId: string;
  driveApiKey: string;
  ghOwner: string;
  ghRepo: string;
  ghToken: string; // Personal Access Token with `workflow` scope
  /** Railway API base URL, e.g. https://netcomix-api.railway.app */
  apiUrl: string;
  /** Shared access code for the Railway API */
  accessCode: string;
}

const KEY = "netcomix.config.v1";

// Public defaults — these point at the owner's shared Drive folder so any
// visitor automatically reads it without any setup. Both values are safe to
// publish:
//   • The Drive folder is shared "Anyone with the link → Viewer".
//   • The API key is restricted to the Drive API (read-only).
// Visitors can still override these via the Setup screen if they want to
// point NetComix at their own Drive folder.
export const BUILT_IN_DRIVE_FOLDER_ID = "12Sz-mb5iQvWJm5tCodTCIYMRPK9fxZiv";
export const BUILT_IN_DRIVE_API_KEY = "AIzaSyBLo-IJS2Ojy4XId9DjiXix_jEY1JnrM6s";

export const EMPTY_CONFIG: NetComixConfig = {
  driveFolderId: "",
  driveApiKey: "",
  ghOwner: "",
  ghRepo: "",
  ghToken: "",
  apiUrl: "",
  accessCode: "",
};

/** Defaults visitors get if they've never touched the Setup screen. */
function defaultConfig(): NetComixConfig {
  // VITE_API_URL / VITE_ACCESS_CODE are set at build time for Railway deploys.
  const fromEnv = (import.meta as unknown as { env?: Record<string, string> }).env;
  return {
    driveFolderId: BUILT_IN_DRIVE_FOLDER_ID,
    driveApiKey: BUILT_IN_DRIVE_API_KEY,
    ghOwner: "",
    ghRepo: "",
    ghToken: "",
    apiUrl: fromEnv?.VITE_API_URL ?? "",
    accessCode: fromEnv?.VITE_ACCESS_CODE ?? "",
  };
}

export function getConfig(): NetComixConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultConfig();
    // Merge stored values over defaults so cleared/empty fields fall back
    // to the built-in Drive folder rather than leaving the app broken.
    const stored = JSON.parse(raw) as Partial<NetComixConfig>;
    const merged = { ...defaultConfig(), ...stored };
    // Allow tests/local dev to opt out of the baked-in Drive defaults by
    // setting `__forceStatic` in the stored config.
    if ((stored as { __forceStatic?: boolean }).__forceStatic) {
      return { ...EMPTY_CONFIG, ...stored };
    }
    return merged;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: NetComixConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}

/** Railway API is configured — use it as the primary data source. */
export function isApiConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.apiUrl);
}

/** Drive is configured (read-side: PWA can list/read). */
export function isDriveConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.driveFolderId && cfg.driveApiKey);
}

/** GitHub is configured (admin-side: PWA can trigger Scan). */
export function isGithubConfigured(cfg: NetComixConfig = getConfig()): boolean {
  return Boolean(cfg.ghOwner && cfg.ghRepo && cfg.ghToken);
}
