/** Exact approval/order binding checked in Convex immediately before a CJ create can be claimed. */
export function hasValidSandboxCjApprovalBinding(input: {
  actionId: unknown;
  action?: { _id: unknown; siteId: unknown; type: string; status: string; params: unknown } | null;
  order?: { _id: unknown; siteId: unknown; cjApprovalActionId?: unknown; cjOrderInput?: { orderNumber: string; logisticName: string; fromCountryCode: string }; cjOrderInputHash?: string; cjLogisticsPreflight?: unknown } | null;
}): boolean {
  const { action, order, actionId } = input;
  if (!action || !order || action._id !== actionId || action.type !== "dispatch_cj_sandbox_order" || action.siteId !== order.siteId || order.cjApprovalActionId !== actionId || !order.cjOrderInput || !order.cjOrderInputHash || !order.cjLogisticsPreflight) return false;
  const params = typeof action.params === "object" && action.params !== null ? action.params as Record<string, unknown> : null;
  return !!params
    && params.orderId === order._id
    && params.orderNumber === order.cjOrderInput.orderNumber
    && params.inputHash === order.cjOrderInputHash
    && params.isSandbox === 1
    && params.payType === 3
    && params.logisticName === order.cjOrderInput.logisticName
    && params.fromCountryCode === order.cjOrderInput.fromCountryCode;
}
