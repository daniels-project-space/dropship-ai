# Checkout, webhook, and fulfillment safety checkpoint — 2026-07-20

Scope completed: Shopify zero-charge sandbox checkout, signed inbound webhooks, and idempotent
CJ sandbox fulfillment. No provider account, checkout, order, invoice, webhook subscription, or
CJ request was contacted or created by this checkout.

## Boundaries now in source

- `POST /api/shopify/test-checkout` is operator-authenticated and accepts only
  `{ siteId, traceId, sandbox: true }`. It can create only a custom, non-shippable `$0.00` Shopify
  draft. It never sends its invoice, completes the draft, creates a customer, reserves inventory,
  or calls CJ. The returned payload intentionally omits the invoice URL.
- Sandbox draft creation requires both `DROPSHIP_AI_SANDBOX_EFFECTS=enabled` and the exact
  development-shop domain in `SHOPIFY_SANDBOX_SHOPS`. The core adapter repeats this check so the
  route cannot be accidentally bypassed.
- `POST /api/webhooks/shopify` checks the raw-body Shopify HMAC, then atomically records a
  delivery receipt and order mirror. `orders/create`, `orders/updated`, and `fulfillments/update`
  are accepted; none trigger fulfillment.
- `POST /api/webhooks/cj` checks a CJ raw-body SHA-256 HMAC (hex or base64), applies tracking
  locally and atomically, and never forwards tracking to Shopify.
- `fulfillOrder` now defaults to `mode: "sandbox"`: it creates a deterministic local
  `sandbox-cj:<site>:<shopify-order>` reference with no network call and returns
  `zeroCharge: true`. Stable outbox keys and target leases prevent duplicate runs.
- Any `mode: "live"` CJ create or Shopify tracking write now requires both
  `DROPSHIP_AI_LIVE_EFFECTS=enabled` and
  `DROPSHIP_AI_LIVE_EFFECTS_CONFIRM=I_UNDERSTAND_THIS_CAN_CREATE_EXTERNAL_EFFECTS` in the
  deployed worker environment. Trigger receives these non-secret flags deliberately.

## Deployment prerequisites (Daniel decision)

1. Use a Shopify development store only, with `write_draft_orders` (and read scopes used by the
   existing connection flow). Add the sandbox flags and shop allowlist only for that environment.
2. Set `SHOPIFY_WEBHOOK_SECRET` and `CJ_WEBHOOK_SECRET`; register HTTPS subscriptions outside this
   checkout after validating endpoint ownership. Do not enable live effects for that test.
3. A live fulfillment or Shopify tracking write remains blocked until Daniel explicitly elects to
   set the dual-control live flags in Vercel/Trigger. That decision can create external effects.

## Verification evidence

- `npm run typecheck` — pass.
- `npm test` — 16/16 passing, including raw-body HMAC, sandbox allowlist, zero-dollar payload,
  create-only CJ `payType:3`, and unauthenticated operator-route rejection.
- `NEXT_PUBLIC_CONVEX_URL=https://tangible-goose-318.convex.cloud npm run build` — pass.
- An ungated build is expected to fail in this checkout because the existing browser provider
  requires `NEXT_PUBLIC_CONVEX_URL`; the scoped build did not contact Convex.
