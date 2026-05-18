import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueManifest } from "../types";
import { pageUrl } from "../library";
import {
  deserialize,
  initialPosition,
  isCover,
  nextPosition,
  prevPosition,
  serialize,
} from "../reader-state";
import { fitPage, snapToPanel, transformToCss, type ViewportTransform } from "../viewport";
import { hapticLight, hapticMedium, playPageTurn, playTick } from "../feedback";
import { loadSettings, saveSettings, type Settings } from "../settings";
import { getProgress, setProgress } from "../storage";
import { usePinchZoom } from "../hooks/usePinchZoom";
import { HudOverlay } from "./HudOverlay";
import "./Reader.css";

interface Props {
  issue: IssueManifest | null;
  issuePath: string;
  onBack: () => void;
}

export function Reader({ issue, issuePath, onBack }: Props) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const updateSettings = (next: Settings) => {
    setSettings(next);
    saveSettings(next);
  };

  const [position, setPosition] = useState(() =>
    issue ? deserialize(getProgress(issue.id)) : initialPosition()
  );
  const [screenSize, setScreenSize] = useState({
    width: typeof window !== "undefined" ? window.innerWidth : 800,
    height: typeof window !== "undefined" ? window.innerHeight : 1200,
  });
  const [hudOpen, setHudOpen] = useState(false);

  // ── Dev tools (pinpoint + panel debug overlay) ─────────────────────────
  const [pinpointMode, setPinpointMode] = useState(false);
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [pinpoints, setPinpoints] = useState<{ x: number; y: number }[]>([]);
  const [panelPos, setPanelPos] = useState({ x: window.innerWidth - 204, y: 12 });
  const dragRef = useRef<{ startMouseX: number; startMouseY: number; startPanelX: number; startPanelY: number } | null>(null);
  const handlePanelDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startPanelX: panelPos.x, startPanelY: panelPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPanelPos({
        x: dragRef.current.startPanelX + ev.clientX - dragRef.current.startMouseX,
        y: dragRef.current.startPanelY + ev.clientY - dragRef.current.startMouseY,
      });
    };
    const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Pinch zoom + drag pan — overrides snap until Next/Prev resets it.
  // Use a callback ref backed by state so the gesture effect re-runs when
  // the stage element mounts (Reader may render an empty state first).
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  // Resize listener
  useEffect(() => {
    const onResize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Persist reading progress
  useEffect(() => {
    if (issue) setProgress(issue.id, serialize(position));
  }, [issue, position]);

  // Compute the "intended" snap transform for current position
  const currentPage = issue?.pages[position.pageIndex];
  const snapTransform: ViewportTransform | null = useMemo(() => {
    if (!issue || !currentPage) return null;
    if (position.panelIndex === -1) return fitPage(currentPage, screenSize);
    const panel = currentPage.panels[position.panelIndex];
    if (!panel) return fitPage(currentPage, screenSize);
    return snapToPanel(panel, screenSize);
  }, [issue, currentPage, position, screenSize]);

  const pinch = usePinchZoom(stageEl, snapTransform);

  // Effective transform: gesture overrides snap when user is panning / zoomed
  const effectiveTransform = pinch.active && pinch.transform ? pinch.transform : snapTransform;

  // Pre-cache next page image
  useEffect(() => {
    if (!issue) return;
    const nextPage = issue.pages[position.pageIndex + 1];
    if (!nextPage) return;
    const img = new Image();
    img.src = pageUrl(issuePath, nextPage);
  }, [issue, position.pageIndex, issuePath]);

  if (!issue || !currentPage) {
    return (
      <div className="empty-state" data-testid="reader-loading">
        <p>Loading…</p>
      </div>
    );
  }

  const goNext = () => {
    // Any active pan/zoom is cleared as we move on — the user can re-engage
    // gestures on the new panel/page if they want to peek around.
    if (pinch.active) pinch.reset();
    const next = nextPosition(position, issue);
    if (!next) return;
    setPosition(next);
    if (settings.haptics) {
      next.pageIndex !== position.pageIndex ? hapticMedium() : hapticLight();
    }
    if (settings.sounds) {
      next.pageIndex !== position.pageIndex ? playPageTurn() : playTick();
    }
  };
  const goPrev = () => {
    if (pinch.active) pinch.reset();
    const prev = prevPosition(position, issue);
    if (!prev) return;
    setPosition(prev);
    if (settings.haptics) {
      prev.pageIndex !== position.pageIndex ? hapticMedium() : hapticLight();
    }
    if (settings.sounds) {
      prev.pageIndex !== position.pageIndex ? playPageTurn() : playTick();
    }
  };

  // Pinpoint click handler — records image-space coordinates
  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pinpointMode || !effectiveTransform) return;
    e.stopPropagation();
    const { translateX: tx, translateY: ty, scale: s } = effectiveTransform;
    const imgX = Math.round((e.clientX - tx) / s);
    const imgY = Math.round((e.clientY - ty) / s);
    setPinpoints((prev) => [...prev, { x: imgX, y: imgY }]);
  };

  // Double-tap anywhere (outside Next/Prev) toggles the HUD.
  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-nohud]")) return;
    setHudOpen((v) => !v);
  };

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(currentPage.dominantColor ?? "")
    ? currentPage.dominantColor!
    : "#222";
  const bgStyle = settings.colorMatchBackground && /^#[0-9a-fA-F]{6}$/.test(currentPage.dominantColor ?? "")
    ? {
        background: `radial-gradient(ellipse at center, ${safeColor}55, #000 75%)`,
      }
    : { background: "#000" };

  const totalPages = issue.pages.length;
  const progressPct = ((position.pageIndex + 1) / totalPages) * 100;

  const opacity = Math.max(settings.buttonOpacity, 0.02);

  const navClass = settings.buttonPosition === "corners" ? "corner" : "side";

  return (
    <div
      className="reader"
      data-testid="reader"
      onDoubleClick={handleDoubleClick}
      onClick={pinpointMode ? handleStageClick : undefined}
    >
      <div className="reader-bg" style={bgStyle} data-testid="reader-bg" />
      <div className="reader-stage" ref={setStageEl}>
        <img
          className="reader-page-img"
          src={pageUrl(issuePath, currentPage)}
          alt={`Page ${position.pageIndex + 1}`}
          data-testid="page-image"
          style={{
            width: currentPage.width,
            height: currentPage.height,
            transform: effectiveTransform ? transformToCss(effectiveTransform) : undefined,
          }}
        />
      </div>

      <button
        className={`ghost-btn ${navClass}-left`}
        data-nohud
        data-testid="prev-btn"
        aria-label="Previous"
        style={{ opacity, background: `rgba(255,255,255,${0.85 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goPrev(); }}
      >‹</button>
      <button
        className={`ghost-btn ${navClass}-right`}
        data-nohud
        data-testid="next-btn"
        aria-label="Next"
        style={{ opacity, background: `rgba(255,255,255,${0.85 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goNext(); }}
      >›</button>

      {/* Pinpoint dots — rendered in image space, positioned via transform */}
      {pinpointMode && effectiveTransform && pinpoints.map((pt, i) => {
        const { translateX: tx, translateY: ty, scale: s } = effectiveTransform;
        const screenX = pt.x * s + tx;
        const screenY = pt.y * s + ty;
        return (
          <div key={i} className="pinpoint-dot" style={{ left: screenX, top: screenY }}>
            <span className="pinpoint-label">{i + 1}: ({pt.x}, {pt.y})</span>
          </div>
        );
      })}

      {/* Pinpoint coordinate list */}
      {pinpointMode && (
        <div className="pinpoint-panel" data-nohud style={{ left: panelPos.x, top: panelPos.y }} onClick={(e) => e.stopPropagation()}>
          <strong className="pinpoint-drag-handle" onMouseDown={handlePanelDragStart}>📍 Pinpoint mode ⠿</strong>
          {pinpoints.length === 0 && <div>Click corners of each panel</div>}
          {pinpoints.map((p, i) => (
            <div key={i}>{i + 1}: x={p.x} y={p.y}</div>
          ))}
          <div className="pinpoint-btn-row">
            <button
              disabled={pinpoints.length === 0}
              onClick={() => {
                const text = pinpoints.map((p, i) => `${i + 1}: (${p.x}, ${p.y})`).join("\n");
                navigator.clipboard.writeText(text);
              }}
            >Copy</button>
            <button onClick={() => setPinpoints([])}>Clear</button>
            <button onClick={() => { setPinpointMode(false); setPinpoints([]); }}>Done</button>
          </div>
        </div>
      )}

      {/* Panel debug overlay boxes */}
      {debugOverlay && effectiveTransform && currentPage.panels.map((panel, i) => {
        const { translateX: tx, translateY: ty, scale: s } = effectiveTransform;
        return (
          <div
            key={i}
            className={`panel-debug-box${i === position.panelIndex ? " active" : ""}`}
            style={{
              left: panel.x * s + tx,
              top: panel.y * s + ty,
              width: panel.w * s,
              height: panel.h * s,
            }}
          >
            <span className="panel-debug-label">{i + 1}</span>
          </div>
        );
      })}

      {/* Dev toolbar — pinpoint + debug overlay (top-right, clear of nav buttons) */}
      <div className="dev-toolbar" data-nohud>
        <button
          className={`dev-btn${debugOverlay ? " active" : ""}`}
          title="Toggle panel debug overlay"
          onClick={(e) => { e.stopPropagation(); setDebugOverlay((v) => !v); }}
        >🔲</button>
        <button
          className={`dev-btn${pinpointMode ? " active" : ""}`}
          title="Pinpoint calibration tool"
          onClick={(e) => { e.stopPropagation(); setPinpointMode((v) => !v); if (pinpointMode) setPinpoints([]); }}
        >📍</button>
      </div>

      <div className="page-counter" data-testid="page-counter">
        {position.panelIndex >= 0
          ? `Page ${position.pageIndex + 1} of ${totalPages} · Panel ${position.panelIndex + 1} of ${currentPage.panels.length}`
          : `Page ${position.pageIndex + 1} of ${totalPages}`}
      </div>

      {hudOpen && (
        <HudOverlay
          title={issue.title}
          subtitle={isCover(position) ? "Cover" : `Page ${position.pageIndex + 1} of ${totalPages}`}
          progressPct={progressPct}
          settings={settings}
          onChangeSettings={updateSettings}
          onClose={() => setHudOpen(false)}
          onBack={onBack}
        />
      )}
    </div>
  );
}
