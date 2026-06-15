"use client";

// Elevated inline sparkline — smoothed Catmull-Rom curve with a soft area-fill
// gradient, an optional left→right draw-in reveal, and a glowing accent dot on
// the latest point. Tone-coloured. Backwards-compatible API (data/width/height/
// color/strokeWidth) plus opt-in `animate` and `glow`.

import { useDrawIn, useInView, smoothPath, useChartId, type Pt } from "../charts/hooks";

export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = "#e8b04b",
  className = "",
  strokeWidth = 1.5,
  animate = false,
  glow = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  strokeWidth?: number;
  animate?: boolean;
  glow?: boolean;
}) {
  const { ref, inView } = useInView<SVGSVGElement>();
  const progress = useDrawIn(animate ? inView : true, 800);
  const gid = useChartId("spark");

  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line x1="0" y1={height - 2} x2={width} y2={height - 2} stroke={color} strokeOpacity="0.35" strokeDasharray="2 3" strokeWidth="1" />
      </svg>
    );
  }

  const pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);

  const pts: Pt[] = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = smoothPath(pts, 0.5);
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const dash = 400;

  return (
    <svg ref={ref} width={width} height={height} className={className} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.24" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} opacity={progress} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={animate ? { strokeDasharray: dash, strokeDashoffset: dash * (1 - progress) } : undefined}
      />
      <circle cx={lx} cy={ly} r="2" fill={color} opacity={progress} style={glow ? { filter: `drop-shadow(0 0 4px ${color})` } : undefined} />
    </svg>
  );
}
