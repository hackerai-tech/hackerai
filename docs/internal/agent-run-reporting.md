# Agent terminal reporting

`agent-long` owns a per-run reporter before database setup. Normal completion
and provider-retry completion share independent terminal and cost capture guards.
The outer `finally` fills only missing records before flushing PostHog. Reporting
does not invoke billing, refunds, model calls, sandbox acquisition, or retries.

Both paths use UUID-v5 identities derived from the Trigger run ID and event name.
Join by `trigger_run_id`; do not infer run completion from a UI-stream pipe or a
configured model. A quota stop is an aborted outcome with `usage_limit` as the
finish reason; it is not a technical error or subscription cancellation.

For `hackerai-usage_cost`:

- `cost_accounting_status=recorded` retains the existing settled/observed cost
  fields and deduction-failure fields. It does not assert that every charge
  succeeded.
- `cost_accounting_status=incomplete` is a coverage record. Full, model, and
  non-model costs are null; settlement is unknown. Never coalesce those fields
  to zero when calculating cost completeness or per-run economics.
- `known_trigger_cost_dollars` is an in-process usage snapshot, not the final
  Trigger invoice amount. `trigger_cost_is_final=false` makes that explicit.
- `observed_accumulated_cost_dollars` is the usage tracker's observation, when
  available. It may overlap the Trigger component after settlement started.
  These two observations must not be added together. Zero is retained only for
  an available zero observation; missing/non-finite observations remain null.

Fallback terminal records carry `terminal_reporting_source=run_finally`, a
bounded failure stage, and an allowlisted category derived before cleanup and
provider wrapping. They contain no raw error message, prompt, target, or stack.
Missing model, sandbox, or experiment fields must remain unknown; use actual
exposure events joined by run ID when evaluating experiments.

Process crashes and hard termination that cannot execute `finally` still require
external Trigger-to-analytics reconciliation. This reporter cannot establish
historical charges or refunds, and must never replay customer billing to repair
missing telemetry.

Before production acceptance, use the designated Preview worker to exercise a
bounded ordinary completion, a setup/database failure fixture, a preparation
failure fixture, a quota stop, and Stop/reconnect. Verify one terminal and one
cost record per run, correct outcome, incomplete costs where appropriate, and
unchanged ledger deductions/refunds. Do not saturate production to create a
fixture. After rollout, reconcile failed production run IDs against both event
types and inspect the worker version before calling coverage complete.
