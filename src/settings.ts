// User-configurable settings, persisted to localStorage.

export type ButtonPosition = "corners" | "sides";
export type Orientation = "auto" | "portrait" | "landscape";
export type HudTrigger = "center-tap" | "long-press" | "both";
export type TransitionStyle = "cinematic" | "fade" | "instant";

export interface Settings {
  buttonOpacity: number;
  buttonPosition: ButtonPosition;
  orientation: Orientation;
  hudTrigger: HudTrigger;
  sounds: boolean;
  haptics: boolean;
  colorMatchBackground: boolean;
  transitionStyle: TransitionStyle;
  panelSnap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  buttonOpacity: 0.15,
  buttonPosition: "corners",
  orientation: "auto",
  hudTrigger: "both",
  sounds: true,
  haptics: true,
  colorMatchBackground: true,
  transitionStyle: "cinematic",
  panelSnap: true,
};

const KEY = "netcomix.settings.v2";

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
  } catch { /* quota/private mode */ }
}
