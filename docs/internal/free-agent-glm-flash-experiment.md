# Free Agent model conversion experiment

Owner, hypothesis, sample plan, rollout decisions, and readout:
[HAC-137](https://linear.app/hackerai/issue/HAC-137).

`free_agent_glm_5_3_flash_conversion_v1` compares the existing
`agent-model-free` DeepSeek V4.1 Flash route (`control`) with the existing
`model-glm-5.3-flash-agent` GLM 5.3 Flash route (`test`). Assignment uses the
authenticated user ID. Only free Agent requests already resolved to the free
Auto route, without image attachments or image tool results at assignment,
are eligible. Text and parsed PDFs are included. Paid Agent, Ask, paid rescue,
limits, authorization, tools, and prompts retain their existing gates.

Missing, inactive, invalid, or unavailable flags leave the DeepSeek default.
The custom `flash_routing_experiment_exposed` event is emitted once when the
matching provider request starts. Assignment and preflight alone are not
exposure. Request outcomes and usage retain the experiment context through
recovery; provider fallbacks are outcomes of the original assignment.

The primary outcome is a positive-payment `subscription_started` event with
`conversion_type=free_to_paid` within seven days of first exposure. Report
only users with complete follow-up for a decision. This can include
reactivations; first-ever paid conversion requires billing-history
reconciliation. Inspect request-level natural completion, errors, aborts,
fallbacks, latency, served models, cost coverage, and sample-ratio mismatch.
The two model keys use their existing provider reasoning and fallback policies,
so the result compares deployed routes rather than model weights alone.

Preview (`hackerai-dev`, 401167) and Production (`HackerAI`, 144137) need
separate flags with the same key. Keep them inactive until the Agent code is
deployed and both actual Trigger workers' PostHog project identities are
verified. A Vercel setting does not prove the Trigger worker selection. Test
both arms with disposable free Agent runs on the user-facing Preview URL,
including a tool call, completion, persistence after reload, cost attribution,
and the disabled-flag fallback. The production ramp and rollback thresholds
are recorded in HAC-137. After a documented decision, remove this routing
code, deploy the permanent route, and archive both flags.
