// Pure math for the "Focal Point" camera — center any panel on the screen.
// Tested separately in viewport.test.ts — no DOM dependencies.

import type { Panel, PageManifest } from "./types";

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
