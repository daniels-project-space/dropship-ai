import type { ReactNode } from "react";

// Standard content well padding inside the shell. `wide` opts into the full
// 1280px measure (tables/grids); default is a comfortable reading measure.
export function PageContainer({
  children,
  wide = false,
  className = "",
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto px-5 pb-24 pt-8 sm:px-8 sm:pt-10 ${
        wide ? "max-w-[1280px]" : "max-w-[1120px]"
      } ${className}`}
    >
      {children}
    </div>
  );
}
