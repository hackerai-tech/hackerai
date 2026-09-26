# Free Ask model conversion experiment

Owner and decision record: [HAC-133](https://linear.app/hackerai/issue/HAC-133).

`free_ask_deepseek_v4_1_conversion_v1` compares GLM 5.3 Flash (`control`)
with DeepSeek V4.1 Flash (`test`). Assignment uses the authenticated user ID.
Only free Ask requests already routed to `ask-model-free-glm`, without image
attachments or image tool results, are eligible. Text and parsed PDFs are
included. Both arms retain low reasoning, including provider and app retries.
The treatment has its own Auto alias so paid allowance rescue remains separate.

The flag fails closed to GLM when missing, inactive, invalid, or unavailable.
Disabling it restores GLM for new requests. Existing requests retain their
assignment. Free Agent, paid requests, limits, authorization, and billing gates
keep their established behavior.

## Exposure and measurement

Use `flash_routing_experiment_exposed`, filtered by `experiment_key`, with
`$feature/free_ask_deepseek_v4_1_conversion_v1` as the variant. The existing
request-scoped recorder emits once when the matching provider request starts;
assignment, preflight, and blocked requests are not exposure. Usage and request
outcomes retain the assignment through recovery. Provider fallbacks are outcomes
of that assignment, not new enrollment.

The primary outcome is a unique exposed user's `subscription_started` event with
`conversion_type=free_to_paid` within seven days of first exposure. This includes
possible reactivations; it must not be described as first-ever paid conversion
without reconciling previous billing history. Use first-exposure attribution and
complete seven-day follow-up cohorts for the decision. The live PostHog view may
include immature users; it is not by itself the final mature-cohort readout.

Secondary metrics track checkout initiation, a successful free Ask response, and
free Ask model cost per exposed user. These are user-level outcomes, not
request-level completion rates. Inspect request-linked errors, latency, fallback
rates, missing outcomes, sample-ratio mismatch, and actual served models before
selecting a winner. Model cost is not complete product margin. The decision
thresholds, sample-size plan, owner, review dates, and cleanup belong in HAC-133.

## Environment and acceptance

Preview `hackerai-dev` (`401167`) and Production `HackerAI` (`144137`) have
independent flags with this same key. Configure a 50/50 variant split; Preview
enrolls 100% of eligible test users. Production enrollment follows the explicit
owner-approved scope in HAC-133 after internal acceptance. Do not reuse the
retired `free_ask_flash_conversion_v1` experiment.

Deploy the application before launch, verify the authorized Convex mapping and
the actual Vercel runtime's PostHog project, then test both variants on the
user-facing Preview URL. Use disposable free Ask chats to check a bounded text
request, parsed PDF, response rendering, reload, low reasoning, one exposure,
and usage attribution. Exercise fallback and a disabled flag. Paid, image, and
Agent requests must not enter this experiment. No Agent routing change is
required; verify Trigger independently if touching its runtime configuration.

After initial deployment, flag changes take effect on the next eligible Ask
request without another deployment. Keep the allocation fixed during the
readout. After an explicit decision, select the permanent route, remove this
experiment code, deploy, and archive both flags. Shipping the code does not
complete the experiment.

Reference: [PostHog custom exposures](https://posthog.com/docs/experiments/exposures).
