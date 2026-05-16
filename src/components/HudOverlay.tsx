import type { Settings, ButtonPosition, Orientation, HudTrigger } from "../settings";

interface Props {
  title: string;
  subtitle: string;
  progressPct: number;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onClose: () => void;
  onBack: () => void;
}

export function HudOverlay({ title, subtitle, progressPct, settings, onChangeSettings, onClose, onBack }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChangeSettings({ ...settings, [k]: v });
  return (
    <div className="hud" data-testid="hud" data-nohud onClick={(e) => e.stopPropagation()}>
      <div className="hud-top">
        <button className="back-btn" data-testid="hud-back" onClick={onBack}>← Library</button>
        <div className="title">{title}</div>
        <button className="back-btn" data-testid="hud-close" onClick={onClose}>Close</button>
      </div>
      <div className="hud-bottom">
        <div className="hud-progress">{subtitle}</div>
        <div className="hud-bar"><div style={{ width: `${progressPct}%` }} /></div>
        <div className="hud-settings" data-testid="hud-settings">
          <label>
            Button transparency
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.buttonOpacity}
              data-testid="opacity-slider"
              onChange={(e) => set("buttonOpacity", parseFloat(e.target.value))}
            />
          </label>
          <label>
            Button position
            <select
              value={settings.buttonPosition}
              data-testid="position-select"
              onChange={(e) => set("buttonPosition", e.target.value as ButtonPosition)}
            >
              <option value="corners">Corners (bottom)</option>
              <option value="sides">Sides (middle)</option>
            </select>
          </label>
          <label>
            Orientation
            <select
              value={settings.orientation}
              data-testid="orientation-select"
              onChange={(e) => set("orientation", e.target.value as Orientation)}
            >
              <option value="auto">Auto</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          <label>
            HUD trigger
            <select
              value={settings.hudTrigger}
              data-testid="hud-trigger-select"
              onChange={(e) => set("hudTrigger", e.target.value as HudTrigger)}
            >
              <option value="both">Both (tap center or long-press)</option>
              <option value="center-tap">Center tap only</option>
              <option value="long-press">Long press only</option>
            </select>
          </label>
          <label>
            Sounds
            <input
              type="checkbox"
              checked={settings.sounds}
              data-testid="sounds-toggle"
              onChange={(e) => set("sounds", e.target.checked)}
            />
          </label>
          <label>
            Haptics
            <input
              type="checkbox"
              checked={settings.haptics}
              data-testid="haptics-toggle"
              onChange={(e) => set("haptics", e.target.checked)}
            />
          </label>
          <label>
            Color-matched background
            <input
              type="checkbox"
              checked={settings.colorMatchBackground}
              data-testid="colormatch-toggle"
              onChange={(e) => set("colorMatchBackground", e.target.checked)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
