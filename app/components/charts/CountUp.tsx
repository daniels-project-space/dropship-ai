"use client";

// Count-up number display — animates from 0 → value when scrolled into view.
// Formatter controls currency / compact / percent rendering.

import { useCountUp, useInView } from "./hooks";

export function CountUp({
  value,
  format = (n: number) => Math.round(n).toLocaleString("en-US"),
  className = "",
  duration = 1100,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  duration?: number;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const n = useCountUp(value, duration, inView);
  return (
    <span ref={ref} className={className}>
      {format(n)}
    </span>
  );
}
