# CJ sandbox dispatch and reconciliation checkpoint — 2026-07-21

The fulfillment worker now permits one supplier write only after it has persisted the complete immutable CJ input snapshot, derived a deterministic `dsa-sb-*` order number, and bound a human-gated action to the snapshot fingerprint. The worker atomically reserves the exact approved action before provider access.

`createSandboxOrder` hard-codes `payType: 3` and `isSandbox: 1`; no live CJ create adapter exists. CJ documents that `isSandbox=1` uses simulated payment and creates no real charge, logistics, or fulfillment. A failure before the CJ request starts (enqueue, target-lock, or outbox-processing) atomically releases only its matching reservation, returns the order to `staged`, and records a failed outbox/trace where one exists. It is therefore safe to retry with a new fenced attempt.

Once the CJ request begins, a timeout, response loss, or 5xx becomes `ambiguous`; the next run queries CJ by the persisted custom order number and accepts only a returned `isSandbox=1` order. A known CJ response completes the order, approval action, outbox, and trace in one Convex mutation. If that mutation response is lost, the worker retries only that idempotent mutation; a later replay repairs the same terminal outbox/trace without a second CJ create. Reusing an outbox idempotency key requires an exact site, kind, target, trace, and canonical payload match. No request body, address, token, or customer input is placed in outbox payloads, traces, logs, or Trigger payloads.

CJ access and refresh tokens must be kept solely in the server vault/control plane as `CJ_ACCESS_TOKEN` and `CJ_REFRESH_TOKEN`. This checkout has no scoped provider or deployment credentials, so no CJ, Shopify, customer, inventory, fulfillment, payment, messaging, Trigger, or R2 operation was performed.

## Production handoff — 2026-07-21

The public production origin is not serving this branch: anonymous `GET https://dropship-ai-cyan.vercel.app/api/status` returned `200` and readiness details; anonymous `POST https://peaceful-panda-894.convex.cloud/api/query` for `orders:getByShopifyOrder` returned `{"status":"success","value":null}`; and `/api/orders/dispatch-sandbox` returned `404`. These are deployment-drift observations, not evidence that the protected branch code is live.

The delivery controller must deploy the commit containing this update together with the generated Convex functions, record the Vercel deployment ID and Git revision, then prove: anonymous `/api/status` and `/api/orders/dispatch-sandbox` return `401`; the same anonymous Convex query returns an authentication error; and one explicitly authorized zero-charge sandbox trace has one matching Convex order/action/outbox/trace and Trigger run. Do not enable live-effect flags or submit any non-sandbox supplier/customer order.

References: [CJ sandbox order documentation](https://developers.cjdropshipping.com/en/api/start/sandbox.html) and [CJ order create/query documentation](https://developers.cjdropshipping.com/en/api/api2/api/shopping.html).
