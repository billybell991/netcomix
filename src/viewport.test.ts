import { describe, expect, it } from "vitest";
import { clampScale, fitPage, snapToPanel, transformToCss } from "./viewport";

const screen = { width: 400, height: 800 };

describe("snapToPanel", () => {
  it("centers a small panel on screen with breathing room", () => {
    const panel = { x: 100, y: 200, w: 200, h: 200, centerX: 200, centerY: 300 };
    const t = snapToPanel(panel, screen);
    // Scale should be limited by smaller of width/height fit (both equal here)
    expect(t.scale).toBeCloseTo((screen.width / 200) * 0.95, 5);
    // Panel center should land near screen center
    expect(t.translateX + panel.centerX * t.scale).toBeCloseTo(screen.width / 2, 5);
    expect(t.translateY + panel.centerY * t.scale).toBeCloseTo(screen.height / 2, 5);
  });

  it("uses the smaller of width/height scale (panel must fit entirely)", () => {
    // Wide panel: height becomes the constraint
    const wide = { x: 0, y: 0, w: 1000, h: 100, centerX: 500, centerY: 50 };
    const t = snapToPanel(wide, screen);
    const scaleX = (screen.width / wide.w) * 0.95;
    const scaleY = (screen.height / wide.h) * 0.95;
    expect(t.scale).toBe(Math.min(scaleX, scaleY));
  });

  it("handles tiny panels without exploding", () => {
    const tiny = { x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 };
    const t = snapToPanel(tiny, screen);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.translateX)).toBe(true);
    expect(Number.isFinite(t.translateY)).toBe(true);
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
