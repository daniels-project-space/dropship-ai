# Production dependency audit — 2026-07-22

The lockfile pins `next@16.2.9` and a compatible root `sharp@0.35.3`. The direct root pin is
intentional: Next's nested `sharp@0.34.5` was affected by GHSA-f88m-g3jw-g9cj, while 0.35.3
supports the project's declared Node `>=20.9.0` target. CI exercises the production build; local
verification additionally decodes, resizes and re-encodes an image through the pinned Sharp.

## Expiring Trigger/OpenTelemetry exception

Owner: Dropship AI maintainers. Expires: **2026-08-22** (must be renewed with a new audit or
removed). `@trigger.dev/sdk` and `@trigger.dev/build` remain on the compatible v4 architecture.
As checked on 2026-07-22, current stable Trigger `4.5.6` still pins OpenTelemetry core 2.7.1 and
related 0.218.0 packages affected by GHSA-8988-4f7v-96qf. `npm audit fix` proposes an incompatible
Trigger v3 downgrade, so it is not an honest automatic fix.

The exposure is confined to server-side Trigger telemetry. Provider/customer bodies are not
placed into task payloads, logs or traces, and service ingress is authenticated. This mitigation
does not change the audit count: the exact full and production counts from the verified commit
must be reported at delivery and rechecked before this exception expires.
