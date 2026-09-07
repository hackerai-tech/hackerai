# Moderation-gated Abliteration pilot

Owner and rollout decisions: [HAC-99](https://linear.app/hackerai/issue/HAC-99).
[Production readout dashboard](https://us.posthog.com/project/144137/dashboard/2070216).
The dashboard includes an assigned-model volume diagnostic
([insight gRZGMouh](https://us.posthog.com/project/144137/insights/gRZGMouh))
so base and Large v2 traffic can be checked independently.

## Routing contract

Paid requests in Ask and Agent may use an Abliteration model at
`https://api.abliteration.ai/v1`. Auto/Standard routes use `abliterated-model`;
explicit HackerAI Pro and Max routes use `abliterated-model-large-v2`. Ultra Ask
Auto also uses Large v2 because its current baseline is Pro, while Ultra Agent
Auto uses the base model because its baseline is Standard. The existing moderation
API must return `shouldUncensorResponse=true`. This signal selects the experiment;
it does not change moderation thresholds, tool approvals, or authorization gates.

Abliteration is limited to the first model-generation step within each
Ask response or Agent run. The shared AI SDK loop uses the assigned Abliteration
model for zero-based step index 0, then switches step 2 and every later step to
the request's saved OpenRouter baseline. The counter resets for each new response
or run; an Agent run can continue through its existing 500-step cap. Provider retry
attempts do not advance the completed-step counter. An Abliteration provider error
still disables the treatment route immediately for the replacement stream.

Because Large v2 is text-only, image attachments and image-view tool results use
the multimodal base `abliterated-model` for every selector, including Pro and Max.
PDFs, files without an image media type, and other unsupported file inputs retain
their original HackerAI route.

Explicit free-allowance rescue requests are excluded before assignment. Eligibility
is recorded before model-priced budget checks so cost-induced blocking cannot
silently remove treatment users from the denominator.

Free subscriptions and paid daily free-allowance rescue requests are excluded.
Every control retains its exact existing baseline. Analyze provider model,
selector, subscription, input modality, and mode separately as well as overall.

`ABLITERATION_API_KEY` is a server credential. Missing credentials, missing flags,
unknown variants, and flag lookup errors preserve the existing route. Only an
explicit `test` assignment selects Abliteration. A `control` assignment preserves
the baseline model. Assignment uses the authenticated user ID, not a request ID.
Feature-flag evaluation does not emit an exposure event.

For the Abliteration treatment, provider-bound preparation does not append the
trusted platform-authorization annotation. Forged authorization tags are still
removed. Sandbox/resume reminders, saved notes, the normal system prompt, tools,
and later agent-loop messages retain their existing behavior. Control and fallback
providers retain their existing platform-authorization preparation.

The provider uses the OpenAI-compatible AI SDK adapter, streaming usage, and native
default reasoning. OpenRouter options, routing lists, user attribution, and PDF
plugins are not sent to the direct endpoint. Existing bounded application retries
use the request's original baseline after an Abliteration failure. Subagents,
summaries, titles, and approval reviewers retain their existing models.

## Environment and rollout record

Definitions read back on 2026-09-06 after Production enrollment was expanded.

| Environment | PostHog project       | Flag ID | Key                           | Configured rollout                                                       |
| ----------- | --------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------ |
| Preview     | hackerai-dev / 401167 | 869147  | abliterated_paid_moderated_v1 | Active; 100% of eligible paid users, forced test                         |
| Production  | HackerAI / 144137     | 869145  | abliterated_paid_moderated_v1 | Active; 100% enrollment, 50/50 control/test, approximately 50% treatment |

Both definitions target `subscription_tier` in `pro`, `pro-plus`, `ultra`, `team`.
The server supplies the current trusted subscription and enforces the remaining
eligibility checks. Production evaluates the explicit test-user override first,
then the broader paid-user experiment group. Keep override traffic out of the
causal readout. Never apply Preview's 100% test split to Production.

Before any deployment/configuration work, independently verify the intended
Convex account, project, designated deployment, URL, and custom domain, and the
checkout/CLI selecting them. Preview belongs only to HackerAI Developer's
designated Preview deployment; Production belongs only to HackerAI's designated
Production deployment. Resolve Vercel and Trigger independently. Do not copy local
Convex state or credentials between environments/checkouts.

Vercel and Trigger each need their own explicitly authorized environment setting
for `ABLITERATION_API_KEY`. Verify the worker's actual PostHog project key, not just
the Vercel setting. Local credential presence in both developer folders was checked;
remote credentials and runtime project selections remain unverified.

Routing-code changes need a new Vercel deployment and a new Trigger worker
deployment. A flag-only change is evaluated on the next Ask request or new Agent
run; it does not reroute an already-running stream.

## Event contract

All new server events carry `experiment_key`, `experiment_variant`,
`$feature/abliterated_paid_moderated_v1`, `experiment_request_id`, mode, tier,
and `generation_step_limit`. Provider-attempt and provider-outcome events also
carry the one-based `generation_step` and `within_abliteration_step_limit`.
Eligibility identifies `assigned_platform_authorization_context`; each provider
attempt identifies its actual `platform_authorization_context` as `not_appended`
for an Abliteration model or `standard` for a control/fallback provider.
The request ID is the original assistant-message ID and stays stable across
provider retries. No new event contains prompts, answers, reasoning, targets,
tool names/arguments, files, raw provider errors, or credentials.

| Event                                  | Meaning                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abliterated_model_eligible`           | Assigned paid/moderation-eligible request before model-priced budget checks; intention-to-treat denominator, including requests blocked by budget or never producing output                                                     |
| `abliterated_model_provider_attempt`   | Actual provider call; sequential attempt counter includes SDK retries and tool-loop steps                                                                                                                                       |
| `abliterated_model_exposed`            | First streamed nonempty text or accepted tool call; once per response, including control/fallback with actual model attribution                                                                                                 |
| `abliterated_model_provider_outcome`   | Per-call completed, empty, error, aborted, incomplete, content-filtered or truncated outcome; duration, first-content latency, text/reasoning lengths, tool-call count, reported token/cache counts and estimated provider cost |
| `abliterated_model_response_outcome`   | Application-level Ask/Agent outcome, fallback/recovery and budget-abort context                                                                                                                                                 |
| `abliterated_model_message_linked`     | Maps a replacement fallback message ID back to the original experiment request                                                                                                                                                  |
| `chat_response_regeneration_requested` | Client regeneration action, with affected message ID and mode; contains no content                                                                                                                                              |
| `chat_response_stop_requested`         | Client Stop action, with affected message ID and mode; distinct from confirmed cancellation                                                                                                                                     |

Exposure means content entered the application stream, not confirmed browser
delivery or task usefulness. Reasoning-only output does not count. A completed
tool-call step does not establish that the overall request succeeded.

Existing `hackerai-usage_cost`, usage settlement, and Agent outcome events retain
the assigned variant even after fallback. Existing `message_feedback_submitted`
joins through `message_id`; use eligible/exposure/message-link events to resolve
replacement message IDs. Billing and later activity join by authenticated
`distinct_id`, without re-evaluating the flag at cancellation time.

## Readout protocol

The one-step phase emits `generation_step_limit=1` on eligibility and provider
events; the earlier three-step phase emitted `3`. Scope each readout by that
property on deduplicated eligible requests, then link all outcomes by
`experiment_request_id`. Compare control/test within the same phase, and do not
pool phases or treat before/after changes as randomized evidence. Production
activation starts with the first verified one-step run, not the Git merge time.

1. Freeze the rollout definition and record the first production exposure date.
   Compare randomized control/test users only. Do not compare treatment with all
   unassigned users. Exclude internal tests and report any assignment crossover.
2. Deduplicate `(distinct_id, experiment_request_id)` from eligible events.
   Left-join final response outcomes and the final provider-call outcome. Missing
   terminal events remain in the denominator and are reported as unknown/failure,
   never silently removed. Primary success requires application success and a
   nonempty final answer; tool-only completion is not sufficient.
3. Report successful nonempty responses per eligible request, absolute differences
   and uncertainty with user-level clustering. Also report unique exposed users,
   eligible requests, mode/tier composition, and per-user request counts. The
   dashboard's raw event counts and per-call metrics are diagnostics, not substitutes
   for the deduplicated primary analysis.
4. Compare linked positive/negative feedback, feedback participation, regeneration,
   Stop, latency, empty/truncated answers, fallback and error rates. Feedback is
   self-selected; nonempty answers are not proof of usefulness. User-level funnel
   charts intentionally include later actions on other models; link messages for
   response-specific conclusions.
5. Sum per-attempt estimated provider spend before dividing by successful eligible
   requests. Failed legs may be refunded/discarded from customer billing; billed
   cost alone understates provider spend. Calls without reported usage have unknown
   cost, not zero. Reconcile with provider billing before expanding. Also compare
   existing billed usage, budget exhaustion and usage-limit pressure.
6. Anchor retention at the user's first eligible request. D1/D7/D30 activity means
   later `hackerai-usage_cost` activity in either Ask or Agent, regardless of model.
   Compare only fully observed 24-hour windows. Do not count recent, immature users
   as churned. Keep monthly/yearly plans and prior tenure separate in the final readout.
7. Measure cancellation intent with `cancellation_completed`; actual subscription
   loss with `subscription_cancelled`. Exclude `retention_pause=true`, separate
   voluntary/involuntary churn, and remove pre-existing cancellation intent from
   incident-churn analysis. Track `subscription_changed`, pause/reversal, and payment
   recovery separately. Use unique at-risk users as denominator, not message counts.
   Dashboard churn funnels are provisional until cohorts mature; renewals may need
   a longer window than D30, especially annual plans.

Operational review: seven days after launch. Retention review: matured D7 and D30
cohorts. Never claim a churn improvement from a small early sample or a nonsignificant
result. No automatic rollout ramp. The owner must record the readout in HAC-99.

Disable the flag on any safety/authorization regression or repeated provider
failures. Investigate >2 percentage points of added failures, >25% p95 latency
regression, or >25% cost-per-success regression; do not wait for statistical
significance during an incident. Final rollout decisions must weigh quality gains
against additional cost. Remove the flag and losing provider path after the final
decision, targeting cleanup within 60 days of launch.

## Verification

Run the bounded live provider test from this checkout:

```sh
corepack pnpm exec tsx scripts/test-abliteration.ts
corepack pnpm exec tsx scripts/test-abliteration.ts --large-v2
```

It loads only the provider credential, uses synthetic arithmetic and an in-memory
tool, exercises the registered provider plus tool IDs and telemetry, caps output
and duration, and does not ingest PostHog events. It is not full app verification.

For release verification on the verified Preview custom URL:

1. Use a disposable paid-user Ask chat and an eligible synthetic authorized lab
   request. Confirm moderation eligibility, streaming completion, model attribution,
   one exposure, and reload persistence. Repeat in Agent with one bounded tool call.
2. Confirm benign/unflagged requests, prohibited-category moderation results,
   moderation failure, free users, PDFs, other unsupported files, and free-allowance
   rescue keep their baseline routes. Confirm image requests use the base Abliteration
   model for Standard, Pro, and Max while text-only Pro/Max requests use Large v2.
   Unit tests cover deterministic gates; use approved synthetic fixtures for
   integration testing rather than customer content.
   In Direct Ask and Agent, force one response/run through at least three sequential
   model-generation steps. Confirm step 1 uses the assigned Abliteration route and
   step 2 onward uses the exact OpenRouter baseline without flag re-evaluation. Start
   a new response/run and confirm its generation-step counter starts again at one.
3. Force the flag off/control and a provider outage. Verify fallback completes,
   assignment stays unchanged in outcomes/costs, replacement messages can be rated,
   and no duplicate tool action occurs.
4. Stop, regenerate, rate, reload, and reconnect the disposable response. Confirm
   message linkage, terminal outcomes, token/cost attribution, and no content in
   analytics. Clean up the test chats. Repeat the bounded journey on the production
   custom domain for the explicit test-user override and sampled treatment cohort
   before any further rollout expansion.

References: [provider models](https://docs.abliteration.ai/models),
[provider pricing](https://docs.abliteration.ai/pricing),
[AI SDK integration](https://docs.abliteration.ai/integrations/vercel-ai-sdk),
[PostHog exposure semantics](https://posthog.com/docs/experiments/exposures),
[PostHog retention](https://posthog.com/docs/product-analytics/retention).
