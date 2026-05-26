import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueManifest } from "../types";
import { pageUrl } from "../library";
import {
  deserialize, initialPosition, isCover,
  nextPosition, prevPosition, serialize,
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

type FadeState = "visible" | "out" | "in";

export function Reader({ issue, issuePath, onBack }: Props) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const updateSettings = (next: Settings) => { setSettings(next); saveSettings(next); };

  const [position, setPosition] = useState(() =>
    issue ? deserialize(getProgress(issue.id)) : initialPosition()
  );
  const [screenSize, setScreenSize] = useState({
    width: typeof window !== "undefined" ? window.innerWidth : 800,
    height: typeof window !== "undefined" ? window.innerHeight : 1200,
  });
  const [hudOpen, setHudOpen] = useState(false);
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [fadeState, setFadeState] = useState<FadeState>("visible");
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  // Swipe tracking
  const swipeRef = useRef<{ x: number; y: number; t: number; touches: number } | null>(null);
  const pendingNavRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onResize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
  }, []);

  useEffect(() => {
    if (issue) setProgress(issue.id, serialize(position));
  }, [issue, position]);

  const currentPage = issue?.pages[position.pageIndex];

  const snapTransform = useMemo<ViewportTransform | null>(() => {
    if (!issue || !currentPage) return null;
    if (!settings.panelSnap || position.panelIndex === -1) return fitPage(currentPage, screenSize);
    const panel = currentPage.panels[position.panelIndex];
    if (!panel) return fitPage(currentPage, screenSize);
    return snapToPanel(panel, screenSize);
  }, [issue, currentPage, position, screenSize, settings.panelSnap]);

  const pinch = usePinchZoom(stageEl, snapTransform);
  const effectiveTransform = pinch.active && pinch.transform ? pinch.transform : snapTransform;

  // Pre-cache next page
  useEffect(() => {
    if (!issue) return;
    const next = issue.pages[position.pageIndex + 1];
    if (next) { const img = new Image(); img.src = pageUrl(issuePath, next); }
  }, [issue, position.pageIndex, issuePath]);

  if (!issue || !currentPage) {
    return (
      <div className="empty-state" data-testid="reader-loading">
        <p>Loading…</p>
      </div>
    );
  }

  // Navigation with transition support
  const navigate = (nextPos: ReturnType<typeof nextPosition>) => {
    if (!nextPos) return;
    if (pinch.active) pinch.reset();

    const doNav = () => {
      setPosition(nextPos);
      if (settings.haptics) {
        nextPos.pageIndex !== position.pageIndex ? hapticMedium() : hapticLight();
      }
      if (settings.sounds) {
        nextPos.pageIndex !== position.pageIndex ? playPageTurn() : playTick();
      }
    };

    if (settings.transitionStyle === "fade") {
      setFadeState("out");
      pendingNavRef.current = doNav;
    } else {
      doNav();
    }
  };

  const goNext = () => navigate(nextPosition(position, issue));
  const goPrev = () => navigate(prevPosition(position, issue));

  // Handle fade overlay transition end
  const handleFadeTransitionEnd = () => {
    if (fadeState === "out") {
      pendingNavRef.current?.();
      pendingNavRef.current = null;
      setFadeState("in");
    } else if (fadeState === "in") {
      setFadeState("visible");
    }
  };

  // Swipe gesture
  const handlePointerDown = (e: React.PointerEvent) => {
    if (hudOpen) return;
    swipeRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), touches: 1 };
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    if (!swipeRef.current || hudOpen) return;
    const dx = e.clientX - swipeRef.current.x;
    const dy = e.clientY - swipeRef.current.y;
    const dt = Date.now() - swipeRef.current.t;
    swipeRef.current = null;
    if (dt < 350 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      dx < 0 ? goNext() : goPrev();
    }
  };

  // Double-tap for HUD
  const lastTapRef = useRef(0);
  const handleTap = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-nohud]")) return;
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setHudOpen((v) => !v);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  };

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(currentPage.dominantColor ?? "")
    ? currentPage.dominantColor!
    : "#111";

  const bgStyle = settings.colorMatchBackground && /^#[0-9a-fA-F]{6}$/.test(currentPage.dominantColor ?? "")
    ? { background: `radial-gradient(ellipse at center, ${safeColor}55, #000 72%)` }
    : { background: "#000" };

  const totalPages = issue.pages.length;
  const progressPct = ((position.pageIndex + 1) / totalPages) * 100;
  const panelCount = settings.panelSnap ? currentPage.panels.length : 0;
  const opacity = Math.max(settings.buttonOpacity, 0.02);
  const navClass = settings.buttonPosition === "corners" ? "corner" : "side";
  const imgClass = [
    "reader-page-img",
    settings.transitionStyle === "cinematic" && !pinch.active ? "transition-cinematic" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className="reader"
      data-testid="reader"
      onClick={handleTap}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <div className="reader-bg" style={bgStyle} data-testid="reader-bg" />

      <div className="reader-stage" ref={setStageEl}>
        <img
          className={imgClass}
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

      {/* Fade overlay for "fade" transition style */}
      <div
        className={`reader-fade-overlay ${fadeState !== "visible" ? "fading" : ""}`}
        onTransitionEnd={handleFadeTransitionEnd}
      />

      {/* Navigation tap zones */}
      <button
        className={`ghost-btn ${navClass}-left`}
        data-nohud
        data-testid="prev-btn"
        aria-label="Previous"
        style={{ opacity, background: `rgba(255,255,255,${0.06 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goPrev(); }}
      />
      <button
        className={`ghost-btn ${navClass}-right`}
        data-nohud
        data-testid="next-btn"
        aria-label="Next"
        style={{ opacity, background: `rgba(255,255,255,${0.06 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goNext(); }}
      />

      {/* Panel dots (only show when on a page with multiple panels) */}
      {settings.panelSnap && panelCount > 1 && (
        <div className="panel-dots" data-testid="panel-dots">
          {/* Show full-page dot first */}
          <div className={`panel-dot ${position.panelIndex === -1 ? "active" : ""}`} />
          {currentPage.panels.map((_, i) => (
            <div key={i} className={`panel-dot ${position.panelIndex === i ? "active" : ""}`} />
          ))}
        </div>
      )}

      {/* Page counter */}
      <div className="page-counter" data-testid="page-counter">
        {position.panelIndex >= 0 && settings.panelSnap
          ? `P${position.pageIndex + 1} · Panel ${position.panelIndex + 1}/${panelCount}`
          : `${position.pageIndex + 1} / ${totalPages}`}
      </div>

      {/* Panel debug overlay */}
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

      {/* Dev toolbar */}
      <div className="dev-toolbar" data-nohud>
        <button
          className={`dev-btn${debugOverlay ? " active" : ""}`}
          title="Panel debug overlay"
          onClick={(e) => { e.stopPropagation(); setDebugOverlay((v) => !v); }}
        >🔲</button>
      </div>

      {/* HUD */}
      {hudOpen && (
        <HudOverlay
          title={issue.title}
          subtitle={isCover(position) ? "Cover" : `Page ${position.pageIndex + 1} of ${totalPages}`}
          progressPct={progressPct}
          pageIndex={position.pageIndex}
          totalPages={totalPages}
          panelIndex={position.panelIndex}
          panelCount={panelCount}
          settings={settings}
          onChangeSettings={updateSettings}
          onClose={() => setHudOpen(false)}
          onBack={onBack}
        />
      )}
    </div>
  );
}
