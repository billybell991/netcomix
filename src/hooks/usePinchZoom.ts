// Pinch-to-zoom hook. Two-finger pinch sets a custom transform; resetting
// returns control to the snap-driven transform.

import { useCallback, useEffect, useRef, useState } from "react";
import { clampScale, type ViewportTransform } from "../viewport";

interface PinchState {
  active: boolean;
  transform: ViewportTransform | null;
  reset: () => void;
}

export function usePinchZoom(stageRef: React.RefObject<HTMLDivElement | null>): PinchState {
  const [active, setActive] = useState(false);
  const [transform, setTransform] = useState<ViewportTransform | null>(null);

  // Track two pointers (multi-touch)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const startDist = useRef<number>(0);
  const startTransform = useRef<ViewportTransform | null>(null);
  const startMid = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    pointers.current.clear();
    setActive(false);
    setTransform(null);
    startTransform.current = null;
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return; // pinch is touch-only
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [p1, p2] = Array.from(pointers.current.values());
        startDist.current = dist(p1, p2);
        startMid.current = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const currScale = transform?.scale ?? 1;
        startTransform.current = {
          scale: currScale,
          translateX: transform?.translateX ?? 0,
          translateY: transform?.translateY ?? 0,
        };
        setActive(true);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size !== 2 || !startTransform.current || !startMid.current) return;
      const [p1, p2] = Array.from(pointers.current.values());
      const d = dist(p1, p2);
      if (startDist.current === 0) return;
      const factor = d / startDist.current;
      const scale = clampScale(startTransform.current.scale * factor);
      // Keep midpoint stable
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dx = mid.x - startMid.current.x;
      const dy = mid.y - startMid.current.y;
      setTransform({
        scale,
        translateX: startTransform.current.translateX + dx,
        translateY: startTransform.current.translateY + dy,
      });
    };
    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) {
        startDist.current = 0;
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
    };
  }, [stageRef, transform]);

  return { active, transform, reset };
}
