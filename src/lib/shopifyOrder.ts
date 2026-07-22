export type ShopifyCreditAdjustmentState = "none" | "partial" | "full";

export type EconomicOrder = {
  sample?: boolean;
  currencyCode?: string;
  currentTotal?: number;
  financialStatus?: string;
  test?: boolean;
  cancelled?: boolean;
  creditAdjustmentState?: ShopifyCreditAdjustmentState;
};

export function normalizeCurrencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

export function creditAdjustmentState(
  financialStatus: string | null | undefined,
  hasRefunds?: boolean,
): ShopifyCreditAdjustmentState {
  const status = (financialStatus ?? "").toUpperCase();
  if (status === "REFUNDED") return "full";
  if (status === "PARTIALLY_REFUNDED" || hasRefunds) return "partial";
  return "none";
}

/** Revenue/conversion truth: only captured, real, unadjusted USD orders are eligible. */
export function eligibleUsdOrder(order: EconomicOrder, storeCurrency: string | undefined): boolean {
  return storeCurrency === "USD"
    && order.sample !== true
    && order.currencyCode === "USD"
    && order.financialStatus === "PAID"
    && order.test === false
    && order.cancelled === false
    && order.creditAdjustmentState === "none"
    && Number.isFinite(order.currentTotal)
    && order.currentTotal! >= 0;
}
