// Tiny inline sparkline — pure SVG, no deps. A smoothed polyline with a soft
// area-fill gradient and an accent dot on the latest point. Tone-coloured.

export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = "#e8b04b",
  className = "",
  strokeWidth = 1.5,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  strokeWidth?: number;
}) {
  if (!data || data.length < 2) {
    // single/empty series → flat baseline so the slot never collapses
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1="0"
          y1={height - 2}
          x2={width}
          y2={height - 2}
          stroke={color}
          strokeOpacity="0.35"
          strokeDasharray="2 3"
          strokeWidth="1"
        />
      </svg>
    );
  }

  const pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);

  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const gid = `spark-${Math.round(pts[0][1] * 100)}-${data.length}-${Math.round(max)}`;

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2" fill={color} />
    </svg>
  );
}
