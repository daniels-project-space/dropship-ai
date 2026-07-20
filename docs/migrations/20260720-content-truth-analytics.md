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
