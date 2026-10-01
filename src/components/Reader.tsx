import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IssueManifest } from "../types";
import { pageUrl } from "../library";
import {
  deserialize, initialPosition, isCover,
  nextPosition, prevPosition, serialize,
} from "../reader-state";
import { fitPage, snapToPanel, snapToBeat, transformToCss, type ViewportTransform } from "../viewport";
import { hapticLight, hapticMedium, playPageTurn, playTick } from "../feedback";
import { loadSettings, saveSettings, type Settings } from "../settings";
import { getProgress, setProgress, setLastRead } from "../storage";
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
  // Panel overlay works in DEV builds OR when localStorage flag is set.
  // Enable on the deployed site: localStorage.setItem('netcomix-debug', '1') in the browser console.
  const [devMode] = useState(() => import.meta.env.DEV || localStorage.getItem('netcomix-debug') === '1');
  const [fadeState, setFadeState] = useState<FadeState>("visible");
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageRefCallback = useCallback((el: HTMLDivElement | null) => { setStageEl(el); }, []);

  // Swipe tracking
  const swipeRef = useRef<{ x: number; y: number; t: number; touches: number } | null>(null);
  const pendingNavRef = useRef<(() => void) | null>(null);
  // Double-tap timing — must be before early return to satisfy Rules of Hooks
  const lastTapRef = useRef(0);
  // Tracks which issue.id we've restored progress for. Prevents the save
  // effect from clobbering saved progress with the initial (0,-1) position
  // during the brief window after fetchIssue resolves but before the
  // restore effect runs. Without this gate, every reader open resets to
  // the cover.
  const restoredIdRef = useRef<string | null>(null);

  useEffect(() => {
    const onResize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
  }, []);

  useEffect(() => {
    if (!issue) return;
    // Don't write progress until we've restored it for this issue.
    if (restoredIdRef.current !== issue.id) return;
    setProgress(issue.id, serialize(position));
    setLastRead(issue.series, issue.id);
  }, [issue, position]);

  const currentPage = issue?.pages[position.pageIndex];

  const snapTransform = useMemo<ViewportTransform | null>(() => {
    if (!issue || !currentPage) return null;
    if (!settings.panelSnap || position.panelIndex === -1) return fitPage(currentPage, screenSize);
    const panel = currentPage.panels[position.panelIndex];
    if (!panel) return fitPage(currentPage, screenSize);
    // Look into a specific text beat (balloon/caption) when one is selected.
    if (settings.beatSnap && position.beatIndex >= 0 && panel.beats?.[position.beatIndex]) {
      return snapToBeat(panel.beats[position.beatIndex], panel, screenSize);
    }
    return snapToPanel(panel, screenSize);
  }, [issue, currentPage, position, screenSize, settings.panelSnap, settings.beatSnap]);

  const pinch = usePinchZoom(stageEl, snapTransform);
  const effectiveTransform = pinch.active && pinch.transform ? pinch.transform : snapTransform;

  // Restore saved progress when a new issue loads
  useEffect(() => {
    if (!issue) return;
    setPosition(deserialize(getProgress(issue.id)));
    restoredIdRef.current = issue.id;
  }, [issue?.id]);

  // Pre-cache next page
  useEffect(() => {
    if (!issue) return;
    const next = issue.pages[position.pageIndex + 1];
    if (next) { const img = new Image(); img.src = pageUrl(issuePath, next); }
  }, [issue, position.pageIndex, issuePath]);

  // Fade transition: "out"→"in" both produce the same CSS class, so no CSS transition
  // fires between them. When fadeState reaches "in", the new page has rendered behind
  // the overlay — kick off the fade-out via rAF. MUST be before early return (Rules of Hooks).
  useEffect(() => {
    if (fadeState !== "in") return;
    const id = requestAnimationFrame(() => setFadeState("visible"));
    return () => cancelAnimationFrame(id);
  }, [fadeState]);

  // Navigation with transition support. Defined before the early return (and
  // not itself a hook) so the keyboard-nav effect below can call it.
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

  const goNext = () => { if (issue) navigate(nextPosition(position, issue, settings.beatSnap)); };
  const goPrev = () => { if (issue) navigate(prevPosition(position, issue, settings.beatSnap)); };

  // Keyboard navigation for desktop/browser users — arrow keys / space to
  // page through, Escape to close the HUD (or back out if it's already closed).
  // MUST be before the early return (Rules of Hooks).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        hudOpen ? setHudOpen(false) : onBack();
        return;
      }
      if (hudOpen) return;
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue, position, settings.beatSnap, settings.transitionStyle, settings.haptics, settings.sounds, hudOpen, onBack]);

  if (!issue || !currentPage) {
    return (
      <div className="empty-state" data-testid="reader-loading">
        <p>Loading…</p>
      </div>
    );
  }

  // Jump straight to any page's full-page view (HUD scrubber). Set position
  // directly — the cinematic transform transition keeps the jump smooth, and
  // skipping the fade machinery makes rapid scrubbing feel responsive.
  const seekToPage = (pageIndex: number) => {
    const last = issue.pages.length - 1;
    const clamped = Math.max(0, Math.min(last, pageIndex));
    if (pinch.active) pinch.reset();
    setPosition({ pageIndex: clamped, panelIndex: -1, beatIndex: -1 });
  };

  // "Start from the beginning" — back to the cover.
  const restart = () => {
    if (pinch.active) pinch.reset();
    setPosition(initialPosition());
    setHudOpen(false);
  };

  // Handle fade overlay transition end
  const handleFadeTransitionEnd = () => {
    if (fadeState === "out") {
      pendingNavRef.current?.();
      pendingNavRef.current = null;
      setFadeState("in");
    }
    // "in" → "visible" is handled by the useEffect above the early return guard.
  };

  // Swipe gesture
  const handlePointerDown = (e: React.PointerEvent) => {
    if (hudOpen) return;
    swipeRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), touches: 1 };
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    if (!swipeRef.current || hudOpen || pinch.active) return;
    const dx = e.clientX - swipeRef.current.x;
    const dy = e.clientY - swipeRef.current.y;
    const dt = Date.now() - swipeRef.current.t;
    swipeRef.current = null;
    if (dt < 350 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      dx < 0 ? goNext() : goPrev();
    }
  };

  // Double-tap for HUD
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
    ? { background: `radial-gradient(ellipse at center, ${safeColor}33 0%, ${safeColor}11 40%, #000 85%)` }
    : { background: "#000" };

  const totalPages = issue.pages.length;
  const panelCount = settings.panelSnap ? currentPage.panels.length : 0;
  const hudSubtitle = isCover(position)
    ? "Cover"
    : position.panelIndex >= 0 && panelCount > 0
      ? `Page ${position.pageIndex + 1} of ${totalPages} · Panel ${position.panelIndex + 1} of ${panelCount}`
      : `Page ${position.pageIndex + 1} of ${totalPages}`;
  const opacity = Math.max(settings.buttonOpacity, 0.02);
  // Icons stay legible even when the user dials buttonOpacity way down for a
  // cleaner look — only the tap-zone tint follows their slider exactly.
  const iconOpacity = Math.max(opacity * 2.4, 0.3);
  const navClass = settings.buttonPosition === "corners" ? "corner" : "side";
  const imgClass = [
    "reader-page-img",
    settings.transitionStyle === "cinematic" && !pinch.active ? "transition-cinematic" : "",
  ].filter(Boolean).join(" ");

  // Dim everything outside the current panel so neighbouring panels don't
  // visually bleed into the "focused" view — keeps the snap loop legible.
  const spotlightPanel = settings.panelSnap && !pinch.active && position.panelIndex >= 0
    ? currentPage.panels[position.panelIndex]
    : undefined;
  const spotlightClass = [
    "panel-spotlight",
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

      <div className="reader-stage" ref={stageRefCallback}>
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

      {spotlightPanel && effectiveTransform && (
        <div
          className={spotlightClass}
          data-testid="panel-spotlight"
          style={{
            left: spotlightPanel.x * effectiveTransform.scale + effectiveTransform.translateX,
            top: spotlightPanel.y * effectiveTransform.scale + effectiveTransform.translateY,
            width: spotlightPanel.w * effectiveTransform.scale,
            height: spotlightPanel.h * effectiveTransform.scale,
          }}
        />
      )}

      {/* Fade overlay for "fade" transition style */}
      <div
        className={`reader-fade-overlay ${fadeState !== "visible" ? "fading" : ""}`}
        onTransitionEnd={handleFadeTransitionEnd}
      />

      {/* Always-visible, low-profile way out — double-tap-to-find-the-HUD
          is not discoverable, so a persistent back affordance lives here too. */}
      <button
        className="reader-back-btn"
        data-nohud
        data-testid="reader-back-btn"
        aria-label="Back to series"
        onClick={(e) => { e.stopPropagation(); onBack(); }}
      >‹</button>

      {/* Navigation tap zones */}
      <button
        className={`ghost-btn ${navClass}-left`}
        data-nohud
        data-testid="prev-btn"
        aria-label="Previous"
        style={{ background: `rgba(255,255,255,${0.06 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goPrev(); }}
      >
        <span className="nav-chevron" style={{ opacity: iconOpacity }}>‹</span>
      </button>
      <button
        className={`ghost-btn ${navClass}-right`}
        data-nohud
        data-testid="next-btn"
        aria-label="Next"
        style={{ background: `rgba(255,255,255,${0.06 * opacity * 4})` }}
        onClick={(e) => { e.stopPropagation(); goNext(); }}
      >
        <span className="nav-chevron" style={{ opacity: iconOpacity }}>›</span>
      </button>

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
        {position.beatIndex >= 0 && settings.beatSnap
          ? `P${position.pageIndex + 1} · Panel ${position.panelIndex + 1} · “” ${position.beatIndex + 1}`
          : position.panelIndex >= 0 && settings.panelSnap
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

      {/* Beat (balloon/caption) debug overlay */}
      {debugOverlay && effectiveTransform && currentPage.panels.flatMap((panel, pi) =>
        (panel.beats ?? []).map((beat, bi) => {
          const { translateX: tx, translateY: ty, scale: s } = effectiveTransform;
          const isActive = pi === position.panelIndex && bi === position.beatIndex;
          return (
            <div
              key={`beat-${pi}-${bi}`}
              style={{
                position: "absolute",
                left: beat.x * s + tx,
                top: beat.y * s + ty,
                width: beat.w * s,
                height: beat.h * s,
                border: `2px solid ${isActive ? "#39ff14" : "#ff3ba7"}`,
                borderRadius: 6,
                boxShadow: isActive ? "0 0 12px #39ff14" : "none",
                pointerEvents: "none",
                zIndex: 7,
              }}
            >
              <span style={{
                position: "absolute", top: -2, left: 2,
                font: "700 11px system-ui", color: isActive ? "#39ff14" : "#ff3ba7",
                textShadow: "0 1px 2px #000",
              }}>{bi + 1}</span>
            </div>
          );
        })
      )}

      {/* Dev toolbar — DEV build, or set localStorage.setItem('netcomix-debug','1') to enable on production */}
      {devMode && (
        <div className="dev-toolbar" data-nohud>
          <button
            className={`dev-btn${debugOverlay ? " active" : ""}`}
            title="Panel debug overlay"
            onClick={(e) => { e.stopPropagation(); setDebugOverlay((v) => !v); }}
          >🔲</button>
        </div>
      )}

      {/* HUD */}
      {hudOpen && (
        <HudOverlay
          title={issue.title}
          subtitle={hudSubtitle}
          pageIndex={position.pageIndex}
          totalPages={totalPages}
          settings={settings}
          onChangeSettings={updateSettings}
          onSeek={seekToPage}
          onRestart={restart}
          onClose={() => setHudOpen(false)}
          onBack={onBack}
        />
      )}
    </div>
  );
}
