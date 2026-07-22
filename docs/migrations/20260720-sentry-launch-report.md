# Sentry launch report — 2026-07-20 UTC

## Decision

Do not launch. The production deployment is not this branch, and the commerce path has a
deliberate manual approval boundary rather than an automatic fulfillment path.

## Branch proof

At `d4a9adc`, `npm ci --no-audit --no-fund`, `npm test` (20/20), `npm run typecheck`, and
`NEXT_PUBLIC_CONVEX_URL=https://peaceful-panda-894.convex.cloud npm run build` pass. The worktree
was clean before the small, user-visible wording correction in this report's commit.

## Dead-glue and rollback audit

- Shopify webhooks atomically mirror an order and explicitly return `fulfillment: "not-triggered"`.
  There is no import or invocation of `fulfillOrder` outside its Trigger task definition.
- `fulfillOrder` has durable intent, target lease, idempotency key, trace, and outbox transitions,
  but is dormant until an explicit approved dispatcher is designed and deployed. This is a safety
  gate, not an elapsed-time stall.
- Sandbox fulfillment produces only a deterministic local `sandbox-cj:*` reference and sends no
  CJ request. Its rollback is therefore local/no-op: no supplier order, payment, inventory
  reservation, tracking update, or customer contact exists to undo.
- Live CJ creation is gated by dual deployment flags. No cancellation/compensation adapter is
  implemented or provider-verified, so a live CJ create must not be auto-retried after an
  ambiguous provider result and must be reconciled by an operator with the supplier before any
  future retry or rollback design is enabled.
- The scheduled signal job records only `source: "heartbeat"`, `trend_score: 0`; it is not product
  discovery evidence and cannot prove a live sourcing workflow.

The orders empty state was corrected to say orders are mirrored and CJ dispatch needs an explicit
approved workflow. It previously claimed automatic dispatch, which contradicted the enforced
source behavior.

## Independent live-plane evidence

Read-only checks at 2026-07-20 16:14 UTC:

- `https://dropship-ai-cyan.vercel.app/api/status?validation=20260720-sentry` returned HTTP 200
  without an operator session. Checked-in `app/api/status/route.ts` requires `requireOperator`.
  Production therefore predates this branch's auth hardening (or is otherwise configuration-drifted).
- The same response reported `goLive: false`, two blockers: zero linked social accounts and no
  Shopify vault token. It reported CJ and Trigger key presence, which is boolean-only readiness,
  not proof of usable credentials or a successful run.
- `GET /api/shopify/test-checkout` returned 404. This checked-out branch has the route, so the
  authorized zero-dollar trace cannot run against the current production deployment.
- `https://peaceful-panda-894.convex.cloud/` returned HTTP 200 and its deployment-running message.
  No protected Convex function was invoked because this checkout has no service or operator token.
- The public storefront `https://snuffloe.uk/` returned HTTP 200 and Shopify headers. That proves
  storefront reachability only; no checkout, cart, customer, inventory, order, or payment action
  was performed.
- No scoped Vercel, Convex, Trigger, R2, Shopify, or CJ credentials are present in this worker.
  Trigger revision/runs and R2 contents remain unverified rather than failed.

## Release and sandbox gates for the controller

1. Deploy this exact commit and verify unauthenticated `GET /api/status` is denied and
   `POST /api/shopify/test-checkout` is present but denies unauthenticated callers.
2. Attach only a development-shop `write_draft_orders` token, its exact
   `SHOPIFY_SANDBOX_SHOPS` entry, and `DROPSHIP_AI_SANDBOX_EFFECTS=enabled`; keep all live-effects
   flags absent. Mint an operator session.
3. Invoke the checkout route once with a unique trace. Accept only a `$0.00`, non-shippable draft
   response that omits an invoice URL and identifies fulfillment as disabled. Do not send/open an
   invoice, complete a checkout, create a customer, reserve inventory, call CJ, update tracking,
   publish, or contact anyone.
4. Independently inspect the resulting Trigger and Convex trace/outbox state with scoped
   read-only provider access. A heartbeat is not evidence of completion; require the actual
   checkpoint/result for the one sandbox request.

Launch remains blocked until the deployed-auth drift is closed, the zero-charge trace is captured,
real sourcing/economics evidence meets the product gates, and Daniel elects an explicit,
recoverable live fulfillment workflow. No deployment, provider mutation, public post, order,
inventory reservation, payment, or outreach was performed by this session.
