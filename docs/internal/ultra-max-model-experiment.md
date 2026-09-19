# Ultra Max model experiment

Owner and decision record: [HAC-127](https://linear.app/hackerai/issue/HAC-127).

## Scope

`ultra_max_glm_5_3_v1` compares the current HackerAI Max route with GLM 5.3
for authenticated Ultra subscribers. Assignment is stable by authenticated
user ID and applies to text-only Ask and Agent requests whose resolved initial
model is `model-grok-4.6`:

| Variant   | Internal model   | Configured provider model |
| --------- | ---------------- | ------------------------- |
| `control` | `model-grok-4.6` | `x-ai/grok-4.6`           |
| `test`    | `model-glm-5.3`  | `z-ai/glm-5.3`            |

The experiment excludes non-Ultra plans, images and image tool results,
moderation/Abliteration reroutes, paid allowance rescue, and subagent-only
routing. Fallbacks after exposure remain attributed by intention to treat and
are reported as a guardrail. Existing authorization, billing, rate limits,
safety gates, prompts, tools, and model recovery chains remain authoritative.
Missing, inactive, invalid, or unavailable flag evaluation retains Grok 4.6.

## Environment and rollout

Separate experiments use the same key:

| Environment | PostHog project           | Experiment / flag   | Enrollment                  | Split |
| ----------- | ------------------------- | ------------------- | --------------------------- | ----- |
| Preview     | `hackerai-dev` / `401167` | `465601` / `897318` | 100% of code-eligible users | 50/50 |
| Production  | `HackerAI` / `144137`     | `465602` / `897319` | 100% of code-eligible users | 50/50 |

Both experiments and flags are drafts/inactive until the code is deployed and
the custom exposure event has been observed in the matching project. After that,
set the experiment exposure criterion to `ultra_max_model_experiment_exposed`
and launch Preview first. Launch Production only after Preview acceptance is
attached to HAC-127.

Both Vercel and Trigger must be deployed before launch. Verify their actual
runtime PostHog project keys independently; a Vercel setting does not prove the
Trigger worker target. No Convex configuration or schema change is required.
After deployment, a flag change affects new requests and Agent runs without a
new deployment. Disable the relevant project's flag to return new requests to
Grok 4.6.

## Exposure and outcomes

`ultra_max_model_experiment_exposed` is emitted once per matching request
lifecycle from the provider-request start callback, and only when the configured
model matches the assignment. Flag evaluation, blocked requests, pre-start
cancellation, rescues, and later reroutes are not exposure. The event contains
only allowlisted routing metadata and no prompt, tool output, file, target, or
other user content.

Use this custom event, filtered by `experiment_key`, as the PostHog exposure
criterion. Existing usage and outcome events receive the same experiment
key/variant and request ID. Analyze by intention to treat, while reporting the
actual served model and fallback/crossover rate per arm.

Primary: natural successful completion (`outcome=success`,
`finish_reason=stop`, and no step-limit termination), split by Ask and Agent.
Secondary quality signals are thumbs feedback, task-outcome responses where
available, regeneration/continuation, and follow-up completion. Guardrails are
errors, aborts, fallback/crossover, time to first token, end-to-end latency,
token usage, provider/total cost, usage settlement/refunds, and Agent
approval/reconnect failures. Check sample-ratio mismatch before interpreting
the result.

## Acceptance and cleanup

- On the actual Preview URL and Trigger Preview worker, use separate eligible
  Ultra accounts assigned to each arm. Complete disposable Ask and Agent Max
  requests; verify rendering, reload/reconnect, configured and served models,
  one custom exposure, usage attribution, a tool call, and natural completion.
- Verify image requests, other plans, Abliteration-eligible requests, allowance
  rescue, and blocked/pre-start canceled requests do not enter or expose.
- Exercise fallback, abort, Agent approval/resume, and a disabled Preview flag.
- Before Production launch, read back both experiment/flag definitions and
  attach runtime identity and Preview acceptance evidence to HAC-127.
- Review health within 24 hours and perform the first outcome readout on or
  after 2026-10-03 once the planned sample is mature. Record win, loss, or
  inconclusive in HAC-127.
- Hard-code the selected route, remove assignment/exposure plumbing, deploy
  Vercel and Trigger, then end/archive both experiments and flags.
