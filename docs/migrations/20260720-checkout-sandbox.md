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

## Independent session-5 verification — 2026-07-20

- `c617599` is the checked-out (shallow) commit on
  `jarvis/goal-make-daniels-project-space-dro-618awssh`; the checkout, webhook, and fulfillment
  source listed above is present in that tree. The worktree was clean before this verification.
- Reinstalled the lockfile-resolved dependencies with `npm ci`, then passed `npm run typecheck`,
  `npm test` (16/16), and
  `NEXT_PUBLIC_CONVEX_URL=https://peaceful-panda-894.convex.cloud npm run build`.
- The session test's fixed suffix could coincidentally equal the valid HMAC suffix. The test now
  deterministically flips that character, so the signed-session fail-closed assertion is real.
- Read-only `GET https://dropship-ai-cyan.vercel.app/api/status` returned 200 without an operator
  session and disclosed readiness metadata. The current source requires `requireOperator` for
  this route, so production is drifted from this checkout (or its deployed configuration differs).
  Its own reported state is `goLive:false`: no Shopify token, no linked social accounts, and
  unverified fal credits. No provider state was changed.
- A genuine zero-charge provider trace has **not** been executed: this worker has no scoped
  Shopify sandbox authorization, and even a $0 draft creation is an external provider mutation.
  The local trace is covered by the mocked adapter test only.
