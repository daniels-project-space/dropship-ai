// Line-glyph icon set (1.6 stroke, currentColor) used across the nav rail, tabs and headers.
// Pure inline SVG — no icon dependency. Each takes an optional size + className.

type IconProps = { size?: number; className?: string };

function base(size: number, className: string, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Icon = {
  portfolio: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </>
    )),
  approvals: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    )),
  content: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m10 9 5 3-5 3z" />
      </>
    )),
  distribution: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="18" cy="5.5" r="2.5" />
        <circle cx="18" cy="18.5" r="2.5" />
        <path d="M8.2 10.8 15.8 6.7M8.2 13.2l7.6 4.1" />
      </>
    )),
  research: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3M8 11h6M11 8v6" />
      </>
    )),
  activity: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="M3 12h4l3 8 4-16 3 8h4" />),
  settings: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>
    )),
  bell: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </>
    )),
  chevron: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="m6 9 6 6 6-6" />),
  chevronRight: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="m9 6 6 6-6 6" />),
  collapse: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M9 4v16" />
      </>
    )),
  menu: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="M3 6h18M3 12h18M3 18h18" />),
  close: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="M18 6 6 18M6 6l12 12" />),
  spark: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="M12 3v4M12 17v4M3 12h4M17 12h4m-2.5-5.5L16 9M8 15l-2.5 2.5M16 15l2.5 2.5M8 9 5.5 6.5" />),
  package: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
        <path d="M3 8l9 5 9-5M12 13v8" />
      </>
    )),
  truck: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M1 4h13v11H1zM14 8h4l3 3v4h-7" />
        <circle cx="5.5" cy="18" r="1.8" />
        <circle cx="17.5" cy="18" r="1.8" />
      </>
    )),
  flame: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1.5.8-2.7.8-2.7S6 8 6 12a6 6 0 0 0 12 0c0-5-6-10-6-10z" />),
  external: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M15 3h6v6M21 3l-9 9" />
        <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
      </>
    )),
  store: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M3 9 4.5 4h15L21 9M3 9v1a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9M5 13v7h14v-7" />
      </>
    )),
  refresh: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v5h-5" />
      </>
    )),
  lock: ({ size = 18, className = "" }: IconProps) =>
    base(size, className, (
      <>
        <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      </>
    )),
};

export type IconKey = keyof typeof Icon;
