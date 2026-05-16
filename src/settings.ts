// User-configurable settings, persisted to localStorage.

export type ButtonPosition = "corners" | "sides";
export type Orientation = "auto" | "portrait" | "landscape";
export type HudTrigger = "center-tap" | "long-press" | "both";

export interface Settings {
  /** Ghost button opacity 0..1 (0 = invisible hit zones) */
  buttonOpacity: number;
  /** Where the next/back hit zones live */
  buttonPosition: ButtonPosition;
  /** Lock orientation? */
  orientation: Orientation;
  /** How to summon the HUD */
  hudTrigger: HudTrigger;
  /** Play page-turn / panel-tick sounds */
  sounds: boolean;
  /** Haptic feedback */
  haptics: boolean;
  /** Color-matched blurred letterbox backgrounds */
  colorMatchBackground: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  buttonOpacity: 0.15,
  buttonPosition: "corners",
  orientation: "auto",
  hudTrigger: "both",
  sounds: true,
  haptics: true,
  colorMatchBackground: true,
};

const KEY = "netcomix.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — ignore */
  }
}
