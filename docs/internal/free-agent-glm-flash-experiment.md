# Free Agent GLM Flash routing

Owner and decision record: [HAC-137](https://linear.app/hackerai/issue/HAC-137).

The owner ended the Free Agent comparison on October 4, 2026 and selected
GLM 5.3 Flash for all free users. This is a product rollout decision, not a
claim of a statistically demonstrated seven-day paid-conversion win.

Free Agent Auto text and parsed PDF requests now select
`model-glm-5.3-flash-agent` (`z-ai/glm-5.3-flash`) directly in the shared
model selector used by HTTP and Trigger Agent runs. Free Ask already selects
`ask-model-free-glm`. Existing image routing, provider recovery, limits,
authorization, tools, prompts, and paid routes retain their gates.

The retired key `free_agent_glm_5_3_flash_conversion_v1` no longer controls
new runs or emits experiment exposure. Historical events remain available.
Deploy both Vercel and Trigger before archiving the separate Preview
(`hackerai-dev`, 401167) and Production (`HackerAI`, 144137) flags; keep their
GLM test variant at 100% while any old runtime still evaluates the key.
In-flight runs retain the route selected when they started.
