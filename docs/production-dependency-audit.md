# Production dependency audit — 2026-07-21

`npm audit --omit=dev` reports **0 high, 0 critical, 13 moderate** findings after the
compatible Socket.IO/Engine.IO/ws/PostCSS overrides in `package.json`.

The remaining findings are one path, repeated through OpenTelemetry packages:

`@trigger.dev/sdk@4.5.5 -> @trigger.dev/core@4.5.5 -> @opentelemetry/*@2.7.1/0.218.0 -> @opentelemetry/core@2.7.1`

The advisory is [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf):
unbounded allocation while parsing W3C Baggage. The deployed exposure is confined to the
server-side Trigger worker telemetry dependency; it is not bundled into the browser and neither
the CJ executor nor its Convex receipt accepts a caller-supplied Baggage value. The application
boundary accepts only authenticated API/Trigger traffic, and CJ customer input remains in Convex
instead of task payloads/logs/traces.

No compatible fixed Trigger v4 release is available: `npm audit fix` proposes downgrading the
selected v4 SDK to `@trigger.dev/sdk@3.3.17`, a breaking change that would invalidate the pinned
v4 task architecture. Keep the v4 line, retain the ingress/PII boundary above, and reassess when
Trigger publishes a v4 release with OpenTelemetry core 2.8.0 or newer.
