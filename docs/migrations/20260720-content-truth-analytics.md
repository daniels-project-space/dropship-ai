# Content truth and analytics checkpoint

Commit `ec3ba4b` closes the content/distribution truth boundary and makes seeded
analytics non-deceptive.

## Invariants now enforced

- AI assets must persist `labelBurned: true` before entering review, approval, or scheduling.
  Legacy AI rows without this evidence fail closed and the UI explains that they require reassembly.
- A post cannot be recorded as published without a non-empty provider post ID. Engagement accepts
  only non-negative provider observations for a provider-confirmed publication.
- `by_creative_platform` makes creative/platform scheduling idempotent, so Trigger retries cannot
  create duplicate rows.
- Semi-manual brands never call a social provider. Automated fan-out additionally requires both
  the site-level automated mode and the dual deployment live-effects acknowledgement.
- Sample sites are excluded by default from portfolio, analytics, content-fit, insights, review,
  distribution, approval, and activity reads. Queries expose an explicit `dataMode: "sample"`
  path for isolated inspection only.

## Verification

- `npm run typecheck` passed.
- `npm test` passed: 20 tests, including label-gate, no-provider-call in semi-manual mode,
  live-effects fail-closed, and sample-mode isolation tests.
- `NEXT_PUBLIC_CONVEX_URL=https://peaceful-panda-894.convex.cloud npm run build` passed.
- `git diff --check` passed before commit.

## Read-only production audit (2026-07-20 UTC)

- Canonical remote is `github.com/daniels-project-space/dropship-ai`.
- `https://dropship-ai-cyan.vercel.app/api/status` responded successfully but reported
  `goLive: false`: Ayrshare has zero linked social accounts and Shopify has no vault token.
  The endpoint reported CJ credentials and Trigger runtime key presence, and fal credits remain
  unverified. No provider write, publication, order, inventory reservation, payment, or outreach
  was attempted.
- `https://peaceful-panda-894.convex.cloud` responded that the deployment is running.
- Direct Trigger, R2, Shopify, and CJ inspection requires scoped provider credentials that are not
  available to this checkout; the production readiness endpoint above is the available boolean-only
  evidence.

The changes are committed locally only. The delivery controller owns merge and deployment.

## Controller handoff: deployment and sandbox truth path (2026-07-20 16:10 UTC)

Revalidation at the checkpoint commit `9d4141e343e1785cc26577d046fdedec1b991684`:

- `npm ci --no-audit --no-fund`, `npm test` (20/20), `npm run typecheck`, and
  `NEXT_PUBLIC_CONVEX_URL=https://peaceful-panda-894.convex.cloud npm run build` all passed.
  `git diff --check` passed and the checkout is clean.
- `https://peaceful-panda-894.convex.cloud` returned HTTP 200. The Convex deployment is
  reachable, but its protected application functions cannot be truth-tested without an
  operator session and must not be invoked with invented credentials.
- A cache-miss request to `https://dropship-ai-cyan.vercel.app/api/status` returned HTTP 200
  without an operator cookie (`x-vercel-id: iad1::iad1::rfzcf-1784563845964-fffbd1f2c09f`).
  It reported `goLive: false`, with zero linked social accounts and no Shopify token.
  This is not the behavior of this checkpoint: the checked-in route calls `requireOperator`.
  Therefore the production deployment cannot be claimed to contain this branch or the secure
  content/analytics fixes.
- No scoped Shopify/CJ sandbox credentials or sandbox-shop allowlist are attached to this
  checkout. No sandbox artifact can be created safely from here, and no provider write,
  publication, order, inventory reservation, payment, or outreach was attempted.

Required controller sequence before launch validation: deploy this exact commit; verify an
unauthenticated `/api/status` request is rejected; then, with a scoped zero-dollar Shopify
test shop and CJ sandbox credential, run the existing test-checkout/sourcing trace under the
sandbox gates. Keep `DROPSHIP_AI_LIVE_EFFECTS` disabled throughout. This is an evidence gate,
not approval to publish, order, reserve stock, spend, or enable go-live.
