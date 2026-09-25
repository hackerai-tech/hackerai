# Retired Ultra Max model experiment

Owner and decision record: [HAC-127](https://linear.app/hackerai/issue/HAC-127).

## Decision

GLM 5.3 was selected for HackerAI Max text requests on 2026-09-21. The
application routes eligible Max text requests directly to `model-glm-5.3`
without evaluating a feature flag or emitting experiment attribution. Image
requests retain their existing multimodal route because they were outside the
experiment population.

The final Production readout was directionally favorable on the operating
metrics that motivated the decision, while PostHog still marked every metric
as having too few exposures for statistical significance:

| Metric                         | Grok 4.6 control | GLM 5.3 test | Difference |
| ------------------------------ | ---------------: | -----------: | ---------: |
| Natural successful completion  |            79.9% |        78.7% |    -1.2 pp |
| Provider cost per exposed user |           $26.00 |       $14.41 |     -44.6% |
| Active model stream duration   |          412.7 s |      339.5 s |     -17.7% |

The readout covered 38 control users and 37 test users. The decision therefore
reflects materially lower cost and faster completion with a similar observed
success rate, not a statistically significant primary-metric win. Historical
results remain in [Production](https://us.posthog.com/project/144137/experiments/465602)
and [Preview](https://us.posthog.com/project/401167/experiments/465601).

## Historical scope

`ultra_max_glm_5_3_v1` compared the previous HackerAI Max route with GLM 5.3
for authenticated users already authorized to use Max. Assignment was stable
by authenticated user ID and applied to text-only Ask and Agent requests whose
resolved initial model was `model-grok-4.6`:

| Variant   | Internal model   | Configured provider model |
| --------- | ---------------- | ------------------------- |
| `control` | `model-grok-4.6` | `x-ai/grok-4.6`           |
| `test`    | `model-glm-5.3`  | `z-ai/glm-5.3`            |

The experiment excluded images and image tool results,
moderation/Abliteration reroutes, paid allowance rescue, and subagent-only
routing. Upstream authorization and model-access checks remained authoritative;
the experiment did not grant access to Max. Existing billing, rate limits,
safety gates, prompts, tools, and model recovery chains remained authoritative.

## Historical environments

Separate experiments used the same key:

| Environment | PostHog project           | Experiment / flag   | Enrollment                  | Split |
| ----------- | ------------------------- | ------------------- | --------------------------- | ----- |
| Preview     | `hackerai-dev` / `401167` | `465601` / `897318` | 100% of code-eligible users | 50/50 |
| Production  | `HackerAI` / `144137`     | `465602` / `897319` | 100% of code-eligible users | 50/50 |

The custom exposure criterion was `ultra_max_model_experiment_exposed`, emitted
once when the assigned provider request started. Flag evaluation, blocked
requests, pre-start cancellation, rescues, and later reroutes were not exposure.
Events contained only allowlisted routing metadata and no prompt, tool output,
file, target, or other user content.

Both Vercel and Trigger had to use the matching PostHog project independently;
a Vercel setting did not prove the Trigger worker target. No Convex
configuration or schema change was required.

The route is now hard-coded and assignment/exposure plumbing has been removed.
Both environment-specific experiments remain as historical records, and their
inactive flags are archived.
