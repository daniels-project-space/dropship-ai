# CJ sandbox dispatch and reconciliation checkpoint — 2026-07-21

The fulfillment worker now permits one supplier write only after it has persisted the complete immutable CJ input snapshot, derived a deterministic `dsa-sb-*` order number, and bound a human-gated action to the snapshot fingerprint. The worker atomically reserves the exact approved action before provider access.

`createSandboxOrder` hard-codes `payType: 3` and `isSandbox: 1`; no live CJ create adapter exists. CJ documents that `isSandbox=1` uses simulated payment and creates no real charge, logistics, or fulfillment. On a timeout, response loss, 5xx, or abandoned reservation, the order becomes `ambiguous`; the next run must query CJ by the persisted custom order number, accept only a returned `isSandbox=1` order, and only then either bind it or reopen a later retry. No request body, address, token, or customer input is placed in outbox payloads, traces, logs, or Trigger payloads.

CJ access and refresh tokens must be kept solely in the server vault/control plane as `CJ_ACCESS_TOKEN` and `CJ_REFRESH_TOKEN`. This checkout can read the existing server vault but has no scoped vault-write capability, so refresh-token rotation cannot be provider-verified here; configure an atomic vault token-bundle rotation writer before enabling a CJ sandbox trace. No CJ, Shopify, customer, inventory, fulfillment, payment, or messaging provider call was made for this checkpoint.

References: [CJ sandbox order documentation](https://developers.cjdropshipping.com/en/api/start/sandbox.html) and [CJ order create/query documentation](https://developers.cjdropshipping.com/en/api/api2/api/shopping.html).
