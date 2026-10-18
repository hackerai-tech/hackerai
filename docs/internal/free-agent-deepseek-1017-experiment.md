# Free Agent model conversion and cost experiment

[HAC-184](https://linear.app/hackerai/issue/HAC-184) owns the hypothesis,
allocation, operational rollback thresholds, review schedule and cleanup.
This is separate from the paid Pro/Auto experiment and retired HAC-137.

`free_agent_deepseek_1017_conversion_v1` assigns authenticated Free Agent users
by stable user ID. Only requests already routed to GLM Flash Agent, with no
native images or image tool results, enroll. Text and parsed PDFs qualify.
Control preserves `z-ai/glm-5.3-flash` and its existing reasoning defaults;
treatment uses `deepseek/deepseek-v4.1-flash-1017` with high reasoning. Later
image tool results retain the assigned model. Compaction models, subagents,
Free Ask, paid routing, limits, moderation and sandbox authorization retain
their existing policies. Missing, disabled, invalid or unavailable flags
preserve GLM for new requests.

Production PostHog 144137 uses 100% eligible enrollment with control/test 50/50.
Preview PostHog 401167 uses a separate same-key flag with 100% eligible
treatment for acceptance. Keep Production inactive until merge and deployment
verification. Verify the actual Vercel and Trigger worker PostHog keys and
designated Convex account/deployment independently. Flag changes then affect
new requests without a redeploy; in-flight requests keep their assignment.

## Primary metrics

- Seven-day paid conversion: unique exposed users with a positive-payment
  `subscription_started`, `conversion_type=free_to_paid` and
  `invoice_amount_paid_dollars > 0`, after first exposure and within seven days.
  Count each user once. Pause resumes and zero-payment grants do not qualify.
  Reactivations may qualify; this is not necessarily first-ever paid conversion.
- Seven-day Free Agent total serving cost per exposed user: all Free Agent
  `hackerai-usage_cost` records after exposure within the same seven-day window,
  including failure, cancellation, fallback and non-enrolled image requests.
  Keep model, tool/sandbox and Trigger cost components distinct. Paid usage
  after conversion is outside this free-serving-cost metric. Cost per converted
  user is diagnostic, not margin or lifetime value.

The live PostHog metrics may include immature users. Use equal, complete
seven-day follow-up cohorts for the decision, with the readout SQL alongside
this document. Keep first exposure fixed, exclude internal QA IDs, retain zero
conversions and missing cost/outcome records, check user-level allocation and
crossover, and stratify by free-budget assignment and sandbox transport.
Account for repeat-user clustering. Do not compare raw paid starts or raw spend.

## Exposure and guardrails

Assignment does not emit exposure. `flash_routing_experiment_exposed` fires once
at the matching provider start with this experiment key and the original
`experiment_request_id`. Blocked preflight requests do not count as exposure.
Existing cost events retain request linkage through fallback. The separate
`free_agent_model_response_outcome` carries technical completion, content,
duration/first model chunk, served model, fallback/recovery, cancellation and
free-budget assignment. Join thumbs by user and its displayed `message_id`.
First chunk can be reasoning; use existing visible-response telemetry for
perceived speed. No prompts, targets, responses or findings are added to analytics.

Check technical completion, blank responses, errors, fallback, cancellation,
cost coverage and p50/p95 timing before expansion. Completion is not task
success. Conversion requires seven full days per exposed user; a complete
enrollment-week comparison takes at least fourteen days. Do not infer a winner
from early operational checks. Never pool this test with HAC-137 or paid HAC-181.

## Acceptance

On the task's verified Vercel Preview, use a configured Free test account and
a connected local/desktop sandbox. Check a bounded text response and harmless
tool request, rendered answer/reload, cancellation and flag-off recovery. Confirm
the exact requested/served snapshot and high reasoning in treatment; GLM/default
reasoning in control; one exposure and request-linked cost/outcome. Check native
images bypass enrollment, later image tool results preserve the assigned model,
and Free Ask/paid requests do not enroll. Preview payment metrics require real
ingested billing events; never fabricate payments to enable a dashboard metric.
