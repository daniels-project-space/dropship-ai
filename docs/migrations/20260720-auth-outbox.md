# Production migration: auth, protected assets, durable execution

This migration is deliberately fail-closed. Apply it before deploying the matching application code; until the values below are present, operator API calls and Convex server clients reject requests rather than falling back to anonymous access.

1. Generate an RSA-2048 keypair outside the repository. Configure the Vercel production environment with `DROPSHIP_AI_OPERATOR_TOKEN`, a random 32+ character `DROPSHIP_AI_SESSION_SECRET`, `DROPSHIP_AI_AUTH_PRIVATE_KEY` (PEM), `DROPSHIP_AI_AUTH_KID`, `DROPSHIP_AI_AUTH_ISSUER` (the exact public Vercel origin, without a trailing slash), and `DROPSHIP_AI_AUTH_AUDIENCE` (a unique value such as `dropship-ai-production`). Configure the same signing identity only in the scoped Trigger runtime.
2. Do not configure `DROPSHIP_AI_SERVICE_TOKEN`. The server mints an RS256 service JWT with `sub: "dropship-ai:service"`, issuer/audience validation, and a five-minute expiry for each route/Trigger-to-Convex client. It never enters the browser, repository, logs, Convex documents, traces, or job payloads.
3. Configure the same `DROPSHIP_AI_AUTH_ISSUER` and `DROPSHIP_AI_AUTH_AUDIENCE` in the target Convex deployment, then deploy the Convex schema and `auth.config.ts`. Convex fetches verification material from `${DROPSHIP_AI_AUTH_ISSUER}/api/auth/jwks`.
4. Deploy the application. Confirm an unauthenticated `GET /api/asset?key=...` returns 401, a signed-in request for a non-creative key returns 400/404, and an anonymous Convex query fails with `UNAUTHENTICATED`.
5. Verify the schema migration created `creatives.by_r2_key`, `targetLocks`, `outbox`, and `traces`. Existing rows are compatible: all new fields/tables are additive.

Rollback is code-only: keep the data tables and index, deploy the prior build, then remove the custom Convex auth configuration only after the replacement access control has been verified. Do not remove R2 credentials or production data.

Operational notes:

- The short-lived service JWT is the sole identity for Trigger/API-to-Convex calls (`sub: dropship-ai:service`). Rotate the signing key through the JWKS `kid` rollover process; no static service bearer token exists.
- `outbox` rows preserve intent; `targetLocks` lease for at most 15 minutes; `traces` record terminal success/failure. Fulfillment and distribution use stable idempotency keys based on the Shopify order or creative ID.
- The CJ `orderNumber` must equal `shopifyOrderId`; this is the supplier-side idempotency reference. Failed supplier calls remain traced and require reconciliation before manually retrying an ambiguous external create.
