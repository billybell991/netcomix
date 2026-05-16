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

  // Pinch zoom — overrides snap until user navigates again
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pinch = usePinchZoom(stageRef);

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

  // Effective transform: pinch overrides snap if user is zoomed
  const effectiveTransform = pinch.active && pinch.transform ? pinch.transform : snapTransform;

  // Pre-cache next page image
  useEffect(() => {
    if (!issue) return;
    const nextPage = issue.pages[position.pageIndex + 1];
    if (!nextPage) return;
    const img = new Image();
    img.src = pageUrl(issuePath, nextPage.file);
  }, [issue, position.pageIndex, issuePath]);

  if (!issue || !currentPage) {
    return (
      <div className="empty-state" data-testid="reader-loading">
        <p>Loading…</p>
      </div>
    );
  }

  const goNext = () => {
    // Zoom override: if user is pinch-zoomed, first reset to snap, don't advance
    if (pinch.active) {
      pinch.reset();
      hapticLight();
      return;
    }
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
    if (pinch.active) {
      pinch.reset();
      hapticLight();
      return;
    }
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

  // Center-tap / long-press HUD trigger
  const handleStageTap = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Ignore taps on buttons / HUD
    if (target.closest("[data-nohud]")) return;
    if (settings.hudTrigger === "long-press") return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Center 40% × 40% region triggers HUD
    if (
      x > rect.width * 0.3 &&
      x < rect.width * 0.7 &&
      y > rect.height * 0.3 &&
      y < rect.height * 0.7
    ) {
      setHudOpen((v) => !v);
    }
  };

  let pressTimer: number | undefined;
  const onPointerDown = () => {
    if (settings.hudTrigger === "center-tap") return;
    pressTimer = window.setTimeout(() => setHudOpen(true), 550);
  };
  const onPointerUp = () => { if (pressTimer) clearTimeout(pressTimer); };

  const bgStyle = settings.colorMatchBackground && currentPage.dominantColor
    ? {
        background: `radial-gradient(ellipse at center, ${currentPage.dominantColor}55, #000 75%)`,
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
      onClick={handleStageTap}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="reader-bg" style={bgStyle} data-testid="reader-bg" />
      <div className="reader-stage" ref={stageRef}>
        <img
          className="reader-page-img"
          src={pageUrl(issuePath, currentPage.file)}
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
