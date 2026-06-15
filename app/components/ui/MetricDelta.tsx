// Signed delta chip (▲/▼) coloured live/danger. Neutral when zero/undefined.
export function MetricDelta({
  value,
  suffix = "%",
  className = "",
}: {
  value: number | null | undefined;
  suffix?: string;
  className?: string;
}) {
  if (value == null) {
    return <span className={`font-mono text-[11px] text-ink-faint ${className}`}>—</span>;
  }
  const up = value > 0;
  const flat = value === 0;
  const tone = flat ? "text-ink-faint" : up ? "text-live" : "text-danger";
  const glyph = flat ? "→" : up ? "▲" : "▼";
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${tone} ${className}`}>
      <span className="text-[9px] leading-none">{glyph}</span>
      {Math.abs(value).toFixed(1)}
      {suffix}
    </span>
  );
}
