// Seeded demo rows must never be silently added to live operational totals.
// Keep this pure so the policy is shared by every portfolio-level read and can be tested
// without a Convex runtime.
export type DataMode = "live" | "sample";

export function matchesDataMode(row: { sample?: boolean }, mode: DataMode = "live"): boolean {
  return mode === "sample" ? row.sample === true : row.sample !== true;
}
