# Durable Shopify-to-CJ staging

`orders/create` now acknowledges Shopify after one signed, atomic Convex intake transaction. It
mirrors the order, writes the webhook receipt, and creates or reuses one `cjStagingIntents` row.
Receipt `outcome: "applied"` therefore means only durable intake, never freight, CJ order
creation, or approval completion.

The scheduled `cj-staging-sweep` task carries only `intentId` to a worker. Customer address and
phone remain in Convex and are excluded from Trigger payloads, outbox rows, traces, audit details,
and logger fields. The worker uses a fenced intent lease and deterministic approval key, so retries
reuse a persisted quote and cannot arm a second approval waitpoint.

The selected `POST /logistic/freightCalculate` response is persisted once with `CJ API v2`, its
selected `logisticName`/price/quoted time, and a SHA-256 digest of site/order, verified source
lineage, origin, destination country, hashed destination ZIP, VID/quantity, endpoint, and version.
Quotes are valid for 30 minutes. A stale quote returns the intent to `preflight_required` and
blocks sandbox execution; it never rewrites an already-approved immutable order snapshot. A fresh
quote after that requires explicit reconciliation and a new human approval before any CJ create.

The `products.by_site_shopify_product_variant` compound index is now required for order-line
mapping. Missing or duplicate mappings fail closed.
