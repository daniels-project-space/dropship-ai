# Durable creative generation

Creative generation now commits one `creativeGenerationIntents` row and all requested
`creativeGenerationVariants` in a single Convex transaction before a Trigger call is attempted.
The caller supplies a stable request ID and the SHA-256 of the exact normalized facts. Reusing an
ID with a different digest or tenant/product binding fails closed.

## Durable stage transitions

Each child starts at `image_submission` and advances only through a matching stage and lease
generation:

`image_submission → image_polling → image_result_copy → clip_submission → clip_polling →
clip_result_copy → tts_reservation → tts_receipt → tts_audio_copy → assembly → review_ready`.

`failed` and `needs_attention` are terminal. Only a failure proven to precede provider submission
is eligible for an explicit operator retry. A durable submission-start marker without a receipt is
ambiguous and enters `needs_attention`; it is never submitted automatically again. Parent status
and requested/active/ready/failed/attention counts are a transactionally maintained projection of
the children, so mixed or missing results cannot be reported as success.

fal work uses the persistent `queue.fal.run` submit/status/response contract. The request ID, exact
model, and canonical status/result endpoint identities are committed immediately after submission.
Status polling is one short Trigger invocation. Completed media is copied to a deterministic R2 key
with an expected media type, size bound, and SHA-256 receipt. The image-to-video input URL lifetime
is the 120-second fal start deadline plus a 60-second margin.

ElevenLabs stores the official `request-id` and `character-cost` headers with the voice, model, text
digest, and character count before body consumption. Every restart is read-only: it finds exactly
one retained history item with that request ID and immutable input, then downloads its audio. Keep
ElevenLabs logging/history enabled. `enable_logging=false` (zero-retention mode) removes the history
needed for safe automatic reconciliation and is incompatible with this workflow.

## Recovery and runtime configuration

The one-minute `creative-generation-recovery` sweep uses bounded indexes for lost handoffs,
expired leases, fal polls, deterministic result copies, TTS recovery, and assembly. Trigger payloads
contain only intent/variant IDs and stage names; prompts and credentials stay out of public jobs and
logs. The shared Trigger queue defaults to three concurrent stages and can be bounded from one to
eight with `CREATIVE_GENERATION_CONCURRENCY`.

Deployment still requires the existing project-scoped Trigger key, service JWT inputs, Convex URL,
vault access, fal and ElevenLabs credentials, R2 credential bundle, FFmpeg layer, and ElevenLabs
history retention. This repository wave does not deploy, change credentials/provider settings,
invoke providers, publish content, or authorize distribution.
