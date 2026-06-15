import Link from "next/link";
import { Icon } from "../Icons";

export type Crumb = { label: string; href?: string };

// Mono breadcrumb trail for the top status bar. Last crumb is the current page (no link).
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {c.href && !last ? (
              <Link
                href={c.href}
                className="truncate font-mono text-[12px] text-ink-faint transition-colors hover:text-ink-dim"
              >
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-mono text-[12px] text-ink">{c.label}</span>
            )}
            {!last && <Icon.chevronRight size={12} className="shrink-0 text-ink-faint/60" />}
          </span>
        );
      })}
    </nav>
  );
}
