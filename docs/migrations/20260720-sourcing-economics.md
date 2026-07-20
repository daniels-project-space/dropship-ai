# Sourcing and economics checkpoint

Decision supported: whether a CJ-backed product may exist as a local draft. The answer is now
deterministic: only fresh, positive US-warehouse CJ evidence with a fully itemized landed-cost
calculation that meets the individual site's price and blended-margin floors can create or refresh
a `draft`. A denial creates an audit entry and no product row.

Implemented surface:

- `src/lib/discovery.ts`: authenticated, server-only Kelkoo offer search and Jina search. Results
  are evidence only; neither provider URL is opened and no catalog mutation occurs.
- `src/lib/cj.ts`: refresh-token exchange plus GET-only product, variant, and inventory reads.
  The operator-gated `POST /api/cj/refresh` aggregates CJ facts without writing externally.
- `convex/products.createSourcedDraft`: US inventory, 24-hour evidence, minimum kit price, and
  contribution-margin gate. It persists COGS, shipping, duty, payment fee, refund reserve,
  content cost, landed cost, and computed margin; it only writes a local draft.

Primary provider evidence (checked 2026-07-20):

- CJ documents `GET /product/query`, `/product/variant/query`, and inventory reads, and its
  refresh endpoint takes a refresh token. https://developers.cjdropshipping.com/en/api/api2/api/product.html
  https://developers.cjdropshipping.com/en/api/api2/api/auth.html
- Kelkoo Shopping API uses a server-side JWT and `GET /search/offers` under
  `https://api.kelkoogroup.net/publisher/shopping/v2/`. https://docs.kelkoogroup.com/for-publishers/quick-starts/how-to-use-jwt-authentication-in-a-shopping-api-or-reporting-api-request
- Jina Search is authenticated with a Bearer API key. https://jina.ai/reader/

Verification: `npm test` (12 passing), `npm run typecheck`, and
`NEXT_PUBLIC_CONVEX_URL=https://tangible-goose-318.convex.cloud npm run build` all pass.
The unparameterized build correctly fails because the existing app requires `NEXT_PUBLIC_CONVEX_URL`
to construct the browser Convex client. No live Vercel/Convex/Trigger/R2/Shopify/CJ state was read:
this scoped checkout has no provider credentials or deployed-app URL, and no external mutation was
attempted.
