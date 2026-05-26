import type { Settings, ButtonPosition, TransitionStyle } from "../settings";

interface Props {
  title: string;
  subtitle: string;
  progressPct: number;
  pageIndex: number;
  totalPages: number;
  panelIndex: number;
  panelCount: number;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onClose: () => void;
  onBack: () => void;
}

export function HudOverlay({
  title, progressPct,
  pageIndex, totalPages, panelIndex, panelCount,
  settings, onChangeSettings, onClose, onBack,
}: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    onChangeSettings({ ...settings, [k]: v });

  return (
    <div className="hud" data-testid="hud" data-nohud onClick={(e) => e.stopPropagation()}>
      {/* Top handle + back */}
      <div className="hud-handle" />

      <div className="hud-nav">
        <button className="back-btn" data-testid="hud-back" onClick={onBack}>
          ← Library
        </button>
        <button className="hud-close-btn" data-testid="hud-close" onClick={onClose}>✕</button>
      </div>

      {/* Progress section */}
      <div className="hud-progress-section">
        <div className="hud-title">{title}</div>
        <div className="hud-subtitle">
          Page {pageIndex + 1} of {totalPages}
          {panelIndex >= 0 && panelCount > 0 && ` · Panel ${panelIndex + 1} of ${panelCount}`}
        </div>
        <div className="hud-bar">
          <div className="hud-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Settings section */}
      <div className="hud-settings" data-testid="hud-settings">
        <div className="hud-settings-title">Settings</div>

        <SettingRow label="Transitions">
          <SegmentedControl
            value={settings.transitionStyle}
            options={[
              { value: "cinematic", label: "Cinematic" },
              { value: "fade",      label: "Fade" },
              { value: "instant",   label: "Instant" },
            ]}
            onChange={(v) => set("transitionStyle", v as TransitionStyle)}
          />
        </SettingRow>

        <SettingRow label="Panel snap">
          <Toggle checked={settings.panelSnap} onChange={(v) => set("panelSnap", v)} />
        </SettingRow>

        <SettingRow label="Buttons">
          <select
            className="hud-select"
            value={settings.buttonPosition}
            onChange={(e) => set("buttonPosition", e.target.value as ButtonPosition)}
          >
            <option value="corners">Corners</option>
            <option value="sides">Sides</option>
          </select>
        </SettingRow>

        <SettingRow label="Button visibility">
          <input
            type="range" min={0} max={1} step={0.05}
            value={settings.buttonOpacity}
            className="hud-range"
            onChange={(e) => set("buttonOpacity", parseFloat(e.target.value))}
          />
        </SettingRow>

        <SettingRow label="Sounds">
          <Toggle checked={settings.sounds} onChange={(v) => set("sounds", v)} />
        </SettingRow>

        <SettingRow label="Haptics">
          <Toggle checked={settings.haptics} onChange={(v) => set("haptics", v)} />
        </SettingRow>

        <SettingRow label="Color background">
          <Toggle checked={settings.colorMatchBackground} onChange={(v) => set("colorMatchBackground", v)} />
        </SettingRow>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <div className="toggle-thumb" />
    </button>
  );
}

function SegmentedControl({
  value, options, onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={`segmented-btn ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
