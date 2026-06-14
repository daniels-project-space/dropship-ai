// A small status indicator. When `live` it emits an expanding pulse ring,
// used for active sites and pending-approval signals.

export function StatusDot({
  className = "",
  hex,
  live = false,
  size = 8,
}: {
  className?: string; // tailwind bg-* token for the dot core
  hex?: string; // colour for the pulse ring (currentColor)
  live?: boolean;
  size?: number;
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, color: hex }}
    >
      <span
        className={`relative z-10 rounded-full ${className}`}
        style={{ width: size, height: size }}
      />
      {live && <span className="pulse-ring absolute inset-0" />}
    </span>
  );
}
