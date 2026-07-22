# Dashboard truth and Convex I/O closure

## Read contracts

`dashboard-v1` keeps source tables authoritative and adds four bounded projections:

- `dashboardSiteSummaries`: exactly one compact row per site. It owns selector fields and current counts (products, actions, posts, review, and current verified commerce).
- `dashboardPortfolioSummaries`: exactly one row per data mode with compact totals and at most 25 product summaries.
- `dashboardDailyRollups`: at most one row per site/day for provider-observed content and current Shopify snapshot commerce.
- `dashboardPortfolioDailyRollups`: at most one row per data mode/day. All-brand reads use these rows; they never multiply site/day queries.

Before the read switch, the old bounded source path remains authoritative. `dashboardMigration.activateReadSwitch` changes the durable `read-switch` row to `ready` only after every entity cursor completes and a bounded site/source/projection comparison reports zero drift. The shell and Command Center then depend only on projection rows. New writes maintain projections throughout backfill, and each page plus cursor commits atomically.

Direct edits to projection tables or direct source-table edits are not a supported mutation contract. Run `beginVerification`, page `verifyPage`, use `repairSite` for each reported site, verify again, and then call `activateReadSwitch`. Verification and repair use capped source pages; neither uses broad `collect`.

## Writer inventory

The projection-aware layer is called by every current writer that changes projected truth:

- sites: create, connect, recurring verification, sync begin/success/failure, expiry, invalidation, settings update, sample seed/clear;
- products: generic create, sourced create/refresh, selection staging, Shopify draft completion, activation/status, and the atomic Shopify snapshot reducer;
- actions: proposal, approve/reject, execute/fail, sourced-product approval creation/completion, and CJ staging creation/supersession/completion;
- posts: schedule, manual transition, provider-confirmed publication, and provider metric correction;
- creatives: generation request/completion, asset ready, approve/reject, and exact publication authorization;
- orders: the atomic Shopify snapshot, independent Shopify observations/invalidation, CJ fulfillment transition, and tracking transition.

The Shopify snapshot is special: up to 250 source products and 250 orders are reduced to one compact product replacement and at most one commerce delta per covered day. It never issues one projection write per source row.

## Before/after I/O formulas

Let `S` be sites (capped at 200 in the old analytics), `P` published posts/site (2,000), `O` orders/site (2,000), `R` products/site (200), `D` requested days (at most 180), and `Q` a review page.

| Surface | Before | Ready projection path |
| --- | --- | --- |
| Always-on shell | `S + S·(actions + products + orders) + S·P + creative point reads` | `S` compact rows + 30 portfolio/day rows + two singleton reads; no post/order history |
| Command Center | four independent `S·(P or O)` series plus platform, funnel, cadence, insights and `S·R·14` product-metric queries | `max(D,84)` daily rows + one compact summary for site **or** all-brand scope |
| Review feeds | `S` status queries, then one dispatch lookup per approved creative | one global indexed queue page + at most `distinctSites(Q)` site point reads |
| Site content tab | one dispatch lookup per returned creative | one indexed creative page; authorization is on the creative row |
| CJ cold bundle | five vault queries | one `secrets:listByService` query, then the existing in-process single-flight coordinator |

Thus shell reads are `O(S)` compact data, Command Center reads are `O(D + compact summaries)` for either scope, review reads are `O(Q + distinctSites(Q))`, and CJ cold resolution is one vault query.

## Truth and availability

Content rollups include reach only when `metricsProvider="ayrshare"` and `metricsObservedAt` is finite. Commerce includes only the current, complete Shopify snapshot generation and eligible paid, non-test, non-cancelled, non-credited USD orders. Refund/cancellation replay replaces the bounded daily commerce facts rather than adding synthetic deltas.

There is no live provider writer for `conversionMetrics`. The Command Center therefore returns `coverage.conversion="unavailable"`, null product CVR, and an explicit unavailable funnel reason. Pageviews, add-to-cart, checkout, and CVR are never derived from rate-only or sample rows.

The status bar reads a durable brain heartbeat/checkpoint. No row means `unknown`; a heartbeat older than five minutes means `offline`; only fresh evidence renders green.

## Deterministic evidence

`tests/dashboard-projections.test.mjs` builds 200 sites and 800+ source/projection rows, runs every resumable backfill cursor, rejects cursor replay, verifies and activates the switch, checks portfolio and selected-site snapshots, introduces drift, blocks activation, repairs, re-verifies, and checks transactional product/action/creative/post transitions. Static source-contract assertions fail if ready Command Center history scans, per-creative dispatch joins, shell subscription fan-out, or five-query CJ bundle reads return.
