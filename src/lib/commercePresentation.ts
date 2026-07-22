export type CommercePresentation = {
  verified: boolean;
  loading: boolean;
  label: "Current" | "Unverified";
  detail: string;
};

/** One deterministic display gate for portfolio and single-brand commerce surfaces. */
export function commercePresentationState(input: {
  days: number;
  revenueVerified?: boolean;
  ordersVerified?: boolean;
  funnelVerified?: boolean;
}): CommercePresentation {
  const loading = input.revenueVerified === undefined
    || input.ordersVerified === undefined
    || input.funnelVerified === undefined;
  const verified = !loading
    && input.days <= 60
    && input.revenueVerified === true
    && input.ordersVerified === true
    && input.funnelVerified === true;
  return {
    verified,
    loading,
    label: verified ? "Current" : "Unverified",
    detail: input.days > 60 ? "Window exceeds verified 60d" : "Awaiting current sync",
  };
}
