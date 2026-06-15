"use client";

// Shared chart primitives: count-up, in-view trigger, smooth-path geometry.
// Pure React + requestAnimationFrame — no animation deps. Respects
// prefers-reduced-motion (jumps straight to the final value/state).

import { useEffect, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// easeOutExpo — fast settle, the Linear/Vercel feel.
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Returns a 0→1 progress that drives the chart draw-in. The animation begins the
 * first time `enabled` becomes true and always settles at exactly 1.
 *
 * IMPORTANT: progress is a *presentation* signal only — it must never be the sole
 * thing that makes a chart visible, because the draw-in can be cut short (tab
 * blur, reduced-motion, async data arriving after the in-view gate fired). The
 * `useEffect` below therefore force-sets progress to 1 on cleanup/teardown so a
 * chart can never get stranded at 0 and render invisible.
 */
export function useDrawIn(enabled: boolean, duration = 900, delay = 0): number {
  const [p, setP] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    if (prefersReducedMotion()) {
      setP(1);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const elapsed = now - start - delay;
      if (elapsed < 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, elapsed / duration);
      setP(easeOutExpo(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setP(1);
    };
    raf = requestAnimationFrame(tick);
    // Safety net: if rAF is throttled/cancelled before completing (background
    // tab, fast unmount), guarantee the chart ends fully drawn rather than blank.
    const settle = setTimeout(() => setP(1), duration + delay + 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [enabled, duration, delay]);

  return p;
}

/** Animated count toward `value`. Returns the current display number. */
export function useCountUp(value: number, duration = 1100, enabled = true): number {
  const [n, setN] = useState(enabled && !prefersReducedMotion() ? 0 : value);
  const from = useRef(0);
  const raf = useRef(0);

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      setN(value);
      return;
    }
    const startVal = from.current;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / duration);
      setN(startVal + (value - startVal) * easeOutExpo(t));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration, enabled]);

  return n;
}

/** IntersectionObserver gate — flips true the first time the node is on-screen. */
export function useInView<T extends Element>(rootMargin = "0px 0px -10% 0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        }
      },
      { rootMargin, threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}

// ── geometry ────────────────────────────────────────────────────────────────

export type Pt = readonly [number, number];

/** Catmull-Rom → cubic Bézier smoothing. Produces a clean flowing path. */
export function smoothPath(pts: Pt[], tension = 0.5): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;

  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

let _uid = 0;
/** Stable-per-instance gradient id. */
export function useChartId(prefix: string): string {
  const ref = useRef<string>("");
  if (!ref.current) ref.current = `${prefix}-${(_uid = (_uid + 1) % 1e9)}`;
  return ref.current;
}
