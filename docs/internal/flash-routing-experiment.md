# Flash routing experiment (HAC-98)

Owner and decision record: [HAC-98](https://linear.app/hackerai/issue/HAC-98).
This is a reversible comparison, not evidence that the model caused a business
decline. Opening or merging the PR does not authorize a production ramp.

## Routes

| Key                              | Code-eligible population                      | Control                 | Test                |
| -------------------------------- | --------------------------------------------- | ----------------------- | ------------------- |
| `paid_agent_glm_flash_return_v1` | Paid Agent already resolved to Flash 0731     | DeepSeek Flash 0731     | GLM 5.3 Flash Agent |
| `free_ask_flash_conversion_v1`   | Free Ask already resolved to `ask-model-free` | DeepSeek Flash 0731 low | GLM 5.3 Flash low   |

Both exclude image attachments and image tool results already in the request.
Paid allowance-rescue traffic is excluded after rate-limit handling, including
control requests whose rescue model happens to equal the assigned model. Paid
Ask, free Agent, premium/Max models, image routes, and subagents stay unchanged.
Prompts, tools, limits, pricing, and billing rules are not changed.

Free Ask pins low reasoning in both arms, including OpenRouter fallbacks. Paid
Agent retains the existing policies for each model: DeepSeek high and GLM's
provider default. Thus the paid comparison measures these routing configurations,
not model weights in isolation. App-side recovery can change models/settings;
report fallback-served rates and actual served models alongside assignment.

Assignment is by authenticated user ID through PostHog, never per message or
client-supplied model choice. Missing, inactive, invalid, or unavailable flags
leave current routing unchanged. Flag cohorts must stay stable during a readout.

## Environment and rollout

| Project                           | Paid flag | Free flag | State / enrollment                        | Split                           |
| --------------------------------- | --------- | --------- | ----------------------------------------- | ------------------------------- |
| Preview `hackerai-dev` / `401167` | `868787`  | `868788`  | Active / 100% of code-eligible test users | 50/50                           |
| Production `HackerAI` / `144137`  | `868785`  | `868786`  | Inactive / 0%                             | 50/50 configured, no enrollment |

These are separate flags with identical keys, not shared configuration. The
first production stage must target an explicit internal allowlist. Record the
allowlist, subsequent enrollment, decision thresholds, and sample-size plan in
HAC-98 before activating or expanding either flag. No automatic ramp is included.

Before testing or launching, independently verify Vercel and Trigger worker
environment, PostHog project, and the authorized Convex account/project/deployment
mapping. Preview must use the designated HackerAI Developer Preview deployment;
Production must use the designated HackerAI Production deployment. Do not copy
credentials across environments. A Vercel setting does not verify Trigger.

New code must be deployed to Vercel and Trigger before enrollment. Once deployed,
flag changes affect new requests/runs without another deployment; existing runs
keep their request-scoped assignment. Disable the relevant flag to restore the
current DeepSeek route for new requests. Do not edit live variant percentages
mid-readout without explicitly ending/restarting that measurement window.

## Exposure and outcomes

`flash_routing_experiment_exposed` is recorded once per matching provider request
lifecycle, from the AI SDK step-start callback after step preparation. Assignment,
preflight, blocked requests, canceled-before-start requests, and a different
initial provider model are not exposure. The callback carries only the configured
model ID, not SDK messages or tool content. `request_id` equals the assistant
message ID (the Trigger run ID for durable Agent runs).

Use the custom exposure event filtered by `experiment_key`, not
`$feature_flag_called`. Usage and Agent outcome events carry the same experiment
key/variant through the existing analytics context. Join request outcomes by
their assistant/run identifiers and users by the authenticated analytics ID.
OpenRouter fallbacks are outcomes of the assigned route, not new assignments.

The free primary metric is **first-ever paid conversion within seven days**:

1. Take each user's first eligible exposure in the enrollment window.
2. Exclude users with successful paid subscription history before exposure;
   use Stripe history, not only the first observed PostHog event. Reactivations
   are not new subscribers. Reconcile customer identity across systems.
3. Restrict the denominator to exposures with a full seven-day follow-up.
4. Count users whose first successful subscription payment is within seven days
   after exposure, once per user. Report numerator, denominator, confidence
   interval, and any crossover or missing billing/identity data for each arm.
5. Preserve intention-to-treat attribution after first exposure; do not relabel
   users based on the model serving a later request or fallback.

Use the predeclared sample-size target and minimum practical effect in HAC-98;
seven elapsed days alone do not establish significance. Check sample-ratio
mismatch and compare source/device composition. Do not divide today's purchases
by today's active users and call it cohort conversion.

Paid primary: natural Agent completion (`outcome=success`, `finish_reason=stop`,
`step_limit_reached=false`) among exposed runs. Guardrails: errors, user aborts,
fallbacks, latency, model/total cost, usage-deduction failures, and cancellation
requests. Keep paid and free populations separate. Completed churn and failed
renewals may reflect pre-exposure decisions and must not be attributed from the
termination date alone.

## Acquisition and billing follow-up

Investigate visitors → signups → successful first answer → checkout → first
payment, segmented by acquisition source and device. First verify the available
events/properties and identity joins; report missing telemetry explicitly. Keep
anonymous visitors, authenticated free users, new customers, and reactivations
distinct. Compare matching weekday/hour windows and complete days.

Split paid losses into new voluntary cancellation requests, scheduled voluntary
endings, and payment failures. Do not change billing recovery in this routing PR.
Any qualitative customer research must use the separate privacy-safe research
workflow; do not inspect prompts or customer content through analytics.

## Manual acceptance and cleanup

- On the verified Preview URL, use separate eligible test accounts assigned to
  each arm. Submit a bounded disposable free Ask chat; verify completion,
  rendering, reload, configured/served model, low reasoning, one custom exposure,
  and correctly attributed usage. Check a PDF request and provider fallback.
- Repeat paid Agent Auto and Standard through the Preview Trigger worker. Check
  a tool call, natural completion, stop/abort, and reload/reconnect. Confirm both
  control and treatment retain matching billing/accounting behavior.
- Verify no treatment/exposure for paid Ask, premium models, image requests,
  free Agent, and paid allowance rescue. A blocked or pre-start canceled request
  must not produce an exposure. Disable a Preview flag and confirm current
  DeepSeek routing returns for a new request.
- Before production, read back both environment definitions and attach actual
  Vercel/Trigger runtime identity evidence and acceptance results to HAC-98.
- Owner reviews health within 24 hours after launch and outcomes after at least
  seven mature days and the planned sample size. Roll back on any billing or
  compatibility regression; use HAC-98's completion/error/cost/latency guardrails.
- Record win/loss/inconclusive, then explicitly select permanent routing, remove
  experiment plumbing, deploy cleanup, and archive/deactivate both projects'
  flags. A merged PR does not mean the experiment is complete.

SDK reference: [PostHog Node feature flags](https://posthog.com/docs/libraries/node#feature-flags).
