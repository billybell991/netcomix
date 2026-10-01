// Pure math for the "Focal Point" camera — center any panel on the screen.
// Tested separately in viewport.test.ts — no DOM dependencies.

import type { Panel, PageManifest, FocusRegion } from "./types";

export interface ViewportTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface Size {
  width: number;
  height: number;
}

const PANEL_PADDING = 0.96; // 4% breathing room — text-bubble overflow is already baked into the panel box by the harvester

/**
 * Compute transform that puts the panel's center on the screen's center,
 * scaled to fit the panel ENTIRELY inside the screen (no cropping).
 *
 * Cropping a comic panel hides speech bubbles and breaks the read, so we
 * accept letterbox bars on the non-binding axis when the panel's aspect
 * ratio mismatches the screen. The user can pinch-zoom + drag-pan if they
 * want a tighter view.
 */
export function snapToPanel(panel: Panel, screen: Size): ViewportTransform {
  // Guard against malformed panels with zero/negative dimensions
  if (panel.w <= 0 || panel.h <= 0) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }
  const scaleX = screen.width / panel.w;
  const scaleY = screen.height / panel.h;
  const scale = Math.min(scaleX, scaleY) * PANEL_PADDING;

  const translateX = screen.width / 2 - panel.centerX * scale;
  const translateY = screen.height / 2 - panel.centerY * scale;

  return { scale, translateX, translateY };
}

// A text beat fills more of the screen than a panel — we want the reader's eye
// pulled toward the words — but not edge-to-edge. The beat boxes come from
// vision detection that can be off by ~10-15%, so we leave a generous margin
// (region fills ~70% of the binding axis) and cap the zoom. That keeps the
// text comfortably in frame even when the box is slightly mislocated, instead
// of zooming so tight that a small drift pushes the words off-screen.
const REGION_PADDING = 0.7;
const REGION_MAX_SCALE = 2.6;

// A beat zoom must always keep at least this fraction of its panel visible on
// each axis. Without it, a small beat (e.g. a one-line caption tucked in the
// corner of a big wide panel) zooms to fill its own width and we end up staring
// at a disorienting thin slice of the panel — a stray face, no context. Capping
// the zoom so ≥30% of the panel stays in frame keeps every beat legible *and*
// anchored in its surroundings, the way an eye flicks to the words without
// losing the picture. (Tight speech balloons already sit at ~35-38% visible, so
// this floor leaves their approved framing untouched.)
const REGION_MIN_PANEL_VISIBLE = 0.3;

/**
 * Compute transform that centers a single text beat (balloon/caption) on screen,
 * zoomed in for comfortable reading. Same focal-point math as snapToPanel, but
 * tighter padding and a max-scale clamp so tiny regions don't over-magnify.
 */
export function snapToRegion(
  region: FocusRegion,
  screen: Size,
  maxScale: number = REGION_MAX_SCALE,
): ViewportTransform {
  if (region.w <= 0 || region.h <= 0) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }
  const scaleX = screen.width / region.w;
  const scaleY = screen.height / region.h;
  const scale = Math.min(Math.min(scaleX, scaleY) * REGION_PADDING, maxScale);

  const translateX = screen.width / 2 - region.centerX * scale;
  const translateY = screen.height / 2 - region.centerY * scale;

  return { scale, translateX, translateY };
}

/**
 * Frame a text beat within its panel. A beat is a focus *inside* a panel, so it
 * must never zoom out past the panel nor pull a neighbouring panel into view.
 *
 * We zoom to the beat (never looser than the panel), centre on it, then clamp
 * the frame to the panel's bounds: on an axis where the panel fills the screen
 * we keep its edges from sliding inward (no neighbour bleed); on an axis where
 * the panel is smaller than the screen (letterboxed) we centre the panel,
 * matching the clean balanced framing of the panel snap. A wide caption that
 * can't be zoomed into therefore settles into the panel frame instead of
 * drifting, while a balloon zooms in tight and stays inside the panel.
 */
export function snapToBeat(
  region: FocusRegion,
  panel: Panel,
  screen: Size,
  maxScale: number = REGION_MAX_SCALE,
): ViewportTransform {
  const panelT = snapToPanel(panel, screen);

  // Wide, short captions waste vertical space at the default region padding —
  // fitting their width to 70% leaves the text tiny and big slivers of the
  // neighbouring panels showing. Give very wide regions a tighter fit so the
  // text fills the frame; squarer regions (speech balloons) keep the gentler
  // padding that already frames them nicely.
  const padding = region.w / region.h > 2.5 ? 0.92 : REGION_PADDING;
  const fit = Math.min(screen.width / region.w, screen.height / region.h);
  // Don't zoom so far in that the panel becomes a thin slice — keep at least
  // REGION_MIN_PANEL_VISIBLE of each panel axis on screen so the beat reads in
  // context (never looser than the panel itself).
  const contextCapX = screen.width / (panel.w * REGION_MIN_PANEL_VISIBLE);
  const contextCapY = screen.height / (panel.h * REGION_MIN_PANEL_VISIBLE);
  const scale = Math.max(
    Math.min(fit * padding, maxScale, contextCapX, contextCapY),
    panelT.scale,
  );

  const pw = panel.w * scale;
  const ph = panel.h * scale;

  let translateX = screen.width / 2 - region.centerX * scale;
  if (pw >= screen.width) {
    const maxTx = -panel.x * scale; // panel left edge pinned to screen left
    const minTx = screen.width - (panel.x + panel.w) * scale; // right edge to screen right
    translateX = Math.min(maxTx, Math.max(minTx, translateX));
  } else {
    translateX = screen.width / 2 - panel.centerX * scale; // centre the (letterboxed) panel
  }

  let translateY = screen.height / 2 - region.centerY * scale;
  if (ph >= screen.height) {
    const maxTy = -panel.y * scale;
    const minTy = screen.height - (panel.y + panel.h) * scale;
    translateY = Math.min(maxTy, Math.max(minTy, translateY));
  } else {
    translateY = screen.height / 2 - panel.centerY * scale;
  }

  return { scale, translateX, translateY };
}

/**
 * Compute transform that fits the entire page in the screen ("Full View" cover state).
 */
export function fitPage(page: Pick<PageManifest, "width" | "height">, screen: Size): ViewportTransform {
  const scaleX = screen.width / page.width;
  const scaleY = screen.height / page.height;
  const scale = Math.min(scaleX, scaleY);
  const translateX = (screen.width - page.width * scale) / 2;
  const translateY = (screen.height - page.height * scale) / 2;
  return { scale, translateX, translateY };
}

export function transformToCss(t: ViewportTransform): string {
  return `translate(${t.translateX}px, ${t.translateY}px) scale(${t.scale})`;
}

/** Clamp a scale between sensible bounds so pinch-zoom can't explode the image. */
export function clampScale(scale: number, min = 0.1, max = 8): number {
  return Math.max(min, Math.min(max, scale));
}
