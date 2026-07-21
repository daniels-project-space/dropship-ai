# Order sandbox lineage release handoff

The approved Shopify DRAFT import now persists both Shopify product and initial-variant IDs beside
the existing CJ product, variant, evidence, and verified-origin facts. A Shopify order webhook
uses signed line-item product/variant IDs only; SKU text is never supplier identity. Convex resolves
each line against the same site's persisted mapping before staging any CJ input.

CJ `createOrderV2` input now requires `logisticName` and `fromCountryCode`. The webhook performs
the documented read-only freight calculation from the persisted verified origin, records the exact
selected quote with the order, and binds those fields into the human approval hash. No eligible
route, mixed origin, unknown/mismatched product mapping, or missing Trigger runtime fails closed.
The Trigger worker never makes a logistics read.

Release blocker: automatic CJ access-token refresh remains deliberately disabled before any refresh
request. This app has no scoped atomic control-plane writer for CJ's rotated access/refresh bundle;
do not store that bundle in Convex, logs, traces, artifacts, jobs, or browser payloads. Attach an
atomic vault token-bundle writer, then run a scoped non-billable sandbox trace.

Provider trace blocker: this checkout has no scoped Shopify development-store/CJ sandbox credentials
or operator session. No Shopify order, CJ order, payment, cart, confirmation, reservation,
fulfillment, notification, publication, or other provider mutation was made from this worktree.
