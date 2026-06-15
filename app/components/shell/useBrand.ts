"use client";

// Active-brand selection, persisted in the URL (?brand=<siteId|all>) so it survives
// reloads and is shareable. "all" (or absent) means the whole portfolio.
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";

export const ALL_BRANDS = "all" as const;

export function useBrand() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const brand = params.get("brand") ?? ALL_BRANDS;

  const setBrand = useCallback(
    (next: string) => {
      const sp = new URLSearchParams(params.toString());
      if (next === ALL_BRANDS) sp.delete("brand");
      else sp.set("brand", next);
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  return { brand, setBrand, isAll: brand === ALL_BRANDS };
}
