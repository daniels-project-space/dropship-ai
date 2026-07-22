# CJ evidence lineage and draft-only Shopify import

## Safety boundary

`POST /api/cj/refresh` now requires a `siteId`, `productId`, and exact `variantId`. It reads CJ
on the server, parses only the selected variant's price plus US warehouse inventory, and persists
one `cjEvidence` row and one succeeded `traces` row (`operation: cj.catalog.read`). Raw CJ JSON
is not accepted by the catalog mutation, and the evidence-recording mutation accepts only the
service identity so an operator/browser token cannot mint favorable evidence.

Unknown is fail-closed: shipping is recorded as `$0` only when CJ explicitly says free shipping;
otherwise it remains absent. `products.createSourcedDraft` takes only `{ siteId, evidenceId,
priceUsd }`, derives COGS, shipping, payment fee, refund reserve, content cost, and landed margin
on the server, and denies unknown, stale, non-US, unverified, out-of-stock, below-price, and
below-margin evidence. `products.setStatus(... active)` replays the same persisted-evidence gate,
and Shopify sync cannot activate a local draft.

## Shopify boundary

`POST /api/shopify/import-draft` requires an operator session and a `human_gated`, approved
`import_sourced_product` action whose `params` exactly bind the local product and evidence IDs.
It reserves a trace before the Shopify call, uses Shopify's `ProductCreateInput` mutation with a
hard-coded `DRAFT` status, then records the external ID. It cannot publish. Any provider failure
is marked `ambiguous` and requires reconciliation; automatic retry is deliberately disabled to
avoid duplicate products.

No provider was contacted by this change. CJ's documented product/variant reads expose variant
USD price and warehouse country/inventory fields, which are the inputs persisted here:
https://developers.cjdropshipping.com/en/api/api2/api/product.html
