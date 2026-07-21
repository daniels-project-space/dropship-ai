# CJ staging recovery rollout

Deploy the schema and worker revision together. `workerAttempt`, generation fingerprint fields,
receipt intent lineage, and `runnableAt` remain optional so existing documents stay readable.

The one-minute CJ staging sweep first invokes `reconcileLegacyCjStagingIntents` with a bounded
limit of 25. It uses the `by_status_runnable_at` index to assign a due value only to legacy
non-terminal rows missing `runnableAt`; it does not scan the table. Pending, preflight-required,
quoted, and staged rows become due immediately. Preflighting and approval-dispatching rows retain
their lease deadline. `approval_dispatched`, `needs_attention`, and `failed` rows remain absent
from the due index.

Rollback is code-only while the fields are optional. Do not remove the new index/fields until the
repair mutation reports zero rows across successive sweep intervals. A superseded approval action
is intentionally terminal: its old Trigger waitpoint can no longer arm or approve, and an
ambiguous dispatch requires operator reconciliation before a replacement generation can exist.
