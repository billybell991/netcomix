import { describe, expect, it } from "vitest";
import { clampScale, fitPage, snapToBeat, snapToPanel, snapToRegion, transformToCss } from "./viewport";

const screen = { width: 400, height: 800 };

describe("snapToPanel", () => {
  it("centers a small panel on screen with breathing room", () => {
    const panel = { x: 100, y: 200, w: 200, h: 200, centerX: 200, centerY: 300 };
    const t = snapToPanel(panel, screen);
    expect(t.scale).toBeCloseTo((screen.width / 200) * 0.96, 5);
    expect(t.translateX + panel.centerX * t.scale).toBeCloseTo(screen.width / 2, 5);
    expect(t.translateY + panel.centerY * t.scale).toBeCloseTo(screen.height / 2, 5);
  });

  it("fits a wide panel without cropping (letterboxes vertically)", () => {
    const wide = { x: 0, y: 0, w: 1000, h: 100, centerX: 500, centerY: 50 };
    const t = snapToPanel(wide, screen);
    const scaleX = (screen.width / wide.w) * 0.96;
    const scaleY = (screen.height / wide.h) * 0.96;
    expect(t.scale).toBe(Math.min(scaleX, scaleY));
    // Panel must NOT overflow the viewport on either axis
    expect(wide.w * t.scale).toBeLessThanOrEqual(screen.width + 1e-6);
    expect(wide.h * t.scale).toBeLessThanOrEqual(screen.height + 1e-6);
  });

  it("handles tiny panels without exploding", () => {
    const tiny = { x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 };
    const t = snapToPanel(tiny, screen);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.translateX)).toBe(true);
    expect(Number.isFinite(t.translateY)).toBe(true);
  });

  it("guards against zero-dimension panels (no Infinity/NaN)", () => {
    const zero = { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 };
    const t = snapToPanel(zero, screen);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(t.scale).toBeGreaterThan(0);
  });

  it("guards against negative-dimension panels", () => {
    const neg = { x: 0, y: 0, w: -10, h: -10, centerX: 0, centerY: 0 };
    const t = snapToPanel(neg, screen);
    expect(Number.isFinite(t.scale)).toBe(true);
  });
});

describe("snapToBeat", () => {
  // A mid-page panel with a wide caption that spans nearly the full panel width.
  const panel = { x: 60, y: 692, w: 521, h: 588, centerX: 320, centerY: 986 };

  it("frames the panel when a near-full-width caption can't be zoomed in much", () => {
    // Full-width caption — fills the panel, so we barely zoom and centre the
    // (letterboxed) panel on both axes rather than revealing neighbours.
    const wideCaption = { x: 75, y: 701, w: 490, h: 78, centerX: 320, centerY: 740 };
    const beat = snapToBeat(wideCaption, panel, screen);
    const panelT = snapToPanel(panel, screen);
    // A hair tighter than the panel so there is a perceptible move, never looser.
    expect(beat.scale).toBeGreaterThanOrEqual(panelT.scale);
    // Panel is smaller than the screen on both axes at this scale → centred.
    expect(beat.translateX + panel.centerX * beat.scale).toBeCloseTo(screen.width / 2, 5);
    expect(beat.translateY + panel.centerY * beat.scale).toBeCloseTo(screen.height / 2, 5);
  });

  it("zooms into a narrow caption and keeps the frame inside the panel", () => {
    // Narrow caption (left-aligned) — tighter than the panel, so we zoom in.
    const caption = { x: 64, y: 696, w: 312, h: 75, centerX: 220, centerY: 733 };
    const beat = snapToBeat(caption, panel, screen);
    const panelT = snapToPanel(panel, screen);
    expect(beat.scale).toBeGreaterThan(panelT.scale);
    // Panel is wider than the screen at this scale → clamp keeps its left edge
    // from sliding inward (no neighbour bleed), never past the screen left.
    const panelLeftOnScreen = panel.x * beat.scale + beat.translateX;
    expect(panelLeftOnScreen).toBeLessThanOrEqual(1e-6);
    const panelRightOnScreen = (panel.x + panel.w) * beat.scale + beat.translateX;
    expect(panelRightOnScreen).toBeGreaterThanOrEqual(screen.width - 1e-6);
    // Panel is shorter than the screen at this scale → centred vertically.
    expect(beat.translateY + panel.centerY * beat.scale).toBeCloseTo(screen.height / 2, 5);
  });

  it("zooms into a small balloon and never reveals outside the panel", () => {
    const balloon = { x: 252, y: 778, w: 140, h: 92, centerX: 322, centerY: 824 };
    const beat = snapToBeat(balloon, panel, screen);
    const panelT = snapToPanel(panel, screen);
    const regionT = snapToRegion(balloon, screen);
    expect(beat.scale).toBeCloseTo(regionT.scale, 5);
    expect(beat.scale).toBeGreaterThan(panelT.scale);
    // The frame must stay inside the panel on both axes.
    expect(panel.x * beat.scale + beat.translateX).toBeLessThanOrEqual(1e-6);
    expect(panel.y * beat.scale + beat.translateY).toBeLessThanOrEqual(1e-6);
    expect((panel.x + panel.w) * beat.scale + beat.translateX).toBeGreaterThanOrEqual(screen.width - 1e-6);
    expect((panel.y + panel.h) * beat.scale + beat.translateY).toBeGreaterThanOrEqual(screen.height - 1e-6);
  });

  it("doesn't zoom a tiny caption in a huge wide panel into a thin slice", () => {
    // A one-line caption tucked in the bottom-right of a very wide panel.
    // Fitting its width alone would zoom to a disorienting strip of the panel.
    const widePanel = { x: 27, y: 1204, w: 1099, h: 496, centerX: 576, centerY: 1452 };
    const tinyCaption = { x: 693, y: 1655, w: 178, h: 38, centerX: 782, centerY: 1674 };
    const beat = snapToBeat(tinyCaption, widePanel, screen);
    const panelT = snapToPanel(widePanel, screen);
    // Never looser than the panel.
    expect(beat.scale).toBeGreaterThanOrEqual(panelT.scale);
    // At least 30% of the panel stays visible on each axis (context cap).
    const visibleW = screen.width / (widePanel.w * beat.scale);
    const visibleH = screen.height / (widePanel.h * beat.scale);
    expect(visibleW).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(visibleH).toBeGreaterThanOrEqual(0.3 - 1e-6);
    // The cap actually bit — we're tighter than the panel but well below the
    // raw width-fit zoom that produced the thin slice.
    const rawFit = Math.min(screen.width / tinyCaption.w, screen.height / tinyCaption.h) * 0.92;
    expect(beat.scale).toBeLessThan(rawFit);
  });
});

describe("fitPage", () => {
  it("fits the page inside the screen and letterboxes equally", () => {
    const page = { width: 800, height: 1200 };
    const t = fitPage(page, screen);
    expect(t.scale).toBe(Math.min(400 / 800, 800 / 1200));
  });

  it("centers a square page on tall screen", () => {
    const t = fitPage({ width: 400, height: 400 }, { width: 400, height: 800 });
    expect(t.translateX).toBe(0);
    expect(t.translateY).toBe(200);
  });
});

describe("clampScale", () => {
  it("clamps to min and max", () => {
    expect(clampScale(0)).toBe(0.1);
    expect(clampScale(100)).toBe(8);
    expect(clampScale(2)).toBe(2);
  });
});

describe("transformToCss", () => {
  it("produces a valid CSS transform string", () => {
    const css = transformToCss({ scale: 1.5, translateX: 10, translateY: -20 });
    expect(css).toBe("translate(10px, -20px) scale(1.5)");
  });
});
