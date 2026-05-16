// Touch/mouse gesture hook: pinch-to-zoom + single-pointer pan.
// Once any drag or pinch begins the hook takes over with its own transform;
// `reset()` returns control to the snap-driven transform (called by Next/Prev).
//
// Single-finger drag pans even from a fresh snap — useful when the auto-snap
// trims something the reader wants to peek at. Pinch zooms; combined two-
// finger drag also pans.

import { useCallback, useEffect, useRef, useState } from "react";
import { clampScale, type ViewportTransform } from "../viewport";

interface PinchState {
  active: boolean;
  transform: ViewportTransform | null;
  reset: () => void;
}

const DRAG_THRESHOLD_PX = 6; // ignore micro-jitter; counts as tap below this

export function usePinchZoom(
  stageEl: HTMLDivElement | null,
  snapTransform: ViewportTransform | null,
): PinchState {
  const [active, setActive] = useState(false);
  const [transform, setTransform] = useState<ViewportTransform | null>(null);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const startDist = useRef<number>(0);
  const startTransform = useRef<ViewportTransform | null>(null);
  const startMid = useRef<{ x: number; y: number } | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  // Refs that mirror state so the gesture effect can read latest values
  // without re-binding listeners (and clobbering an in-progress drag).
  const snapRef = useRef<ViewportTransform | null>(snapTransform);
  snapRef.current = snapTransform;
  const transformRef = useRef<ViewportTransform | null>(null);
  transformRef.current = transform;
  const activeRef = useRef(false);
  activeRef.current = active;

  const reset = useCallback(() => {
    pointers.current.clear();
    setActive(false);
    setTransform(null);
    startTransform.current = null;
    startMid.current = null;
    startDist.current = 0;
    downAt.current = null;
  }, []);

  useEffect(() => {
    const el = stageEl;
    if (!el) return;

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    // Seed startTransform from current pan transform if already active, else snap.
    const seedTransform = (): ViewportTransform =>
      transformRef.current ?? snapRef.current ?? { scale: 1, translateX: 0, translateY: 0 };

    const onDown = (e: PointerEvent) => {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [p1, p2] = Array.from(pointers.current.values());
        startDist.current = dist(p1, p2);
        startMid.current = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        startTransform.current = seedTransform();
        setActive(true);
        downAt.current = null;
      } else if (pointers.current.size === 1) {
        // Defer "active" until the user actually moves past the threshold —
        // taps shouldn't accidentally swap the transform.
        const [p] = Array.from(pointers.current.values());
        startMid.current = { x: p.x, y: p.y };
        downAt.current = { x: p.x, y: p.y };
        startTransform.current = seedTransform();
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!startTransform.current || !startMid.current) return;

      if (pointers.current.size === 2) {
        const [p1, p2] = Array.from(pointers.current.values());
        const d = dist(p1, p2);
        if (startDist.current === 0) return;
        const factor = d / startDist.current;
        const scale = clampScale(startTransform.current.scale * factor);
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const dx = mid.x - startMid.current.x;
        const dy = mid.y - startMid.current.y;
        setTransform({
          scale,
          translateX: startTransform.current.translateX + dx,
          translateY: startTransform.current.translateY + dy,
        });
      } else if (pointers.current.size === 1) {
        const [p] = Array.from(pointers.current.values());
        const dx = p.x - startMid.current.x;
        const dy = p.y - startMid.current.y;
        if (!activeRef.current) {
          if (!downAt.current) return;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          setActive(true);
        }
        setTransform({
          scale: startTransform.current.scale,
          translateX: startTransform.current.translateX + dx,
          translateY: startTransform.current.translateY + dy,
        });
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 1) {
        startDist.current = 0;
        const [p] = Array.from(pointers.current.values());
        startMid.current = { x: p.x, y: p.y };
        startTransform.current = seedTransform();
      } else if (pointers.current.size === 0) {
        startDist.current = 0;
        downAt.current = null;
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      pointers.current.clear();
      startDist.current = 0;
      startTransform.current = null;
      startMid.current = null;
      downAt.current = null;
    };
  }, [stageEl]);

  return { active, transform, reset };
}
