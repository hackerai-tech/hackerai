# Provider prompt caching

Prompt caching reuses a provider's computation of an identical input prefix. It
does not reuse an assistant answer or skip tools, authorization, or fresh model
generation. A stable request makes a hit possible; eviction, routing and provider
support still determine whether one occurs.

## Request invariants

Shared Ask/Agent requests use an opaque affinity key derived from chat, mode and
the actual requested model slug. OpenRouter receives `session_id`; direct
Abliteration receives `prompt_cache_key` under the adapter's `abliteration`
provider-options namespace. Direct Inference Cyber keeps its existing automatic
caching behavior; no unverified affinity option is sent. Delegated agents use their own subagent ID and mode,
so siblings and parents do not compete for a routing identity. Continuations and
retries retain it; model promotion gets a separate key. The existing key format
is preserved so warmed DeepSeek sessions are not invalidated by this change.

Claude requests retain the last-user cache anchor and add one breakpoint on the
final tool result. The installed SDK serializes a message-level tool marker onto
every result in a parallel batch, so only the last result part is marked.
Re-decoration removes old cache hints from request-local copies before adding
the current anchors. Together with the one or two system anchors this uses at most four slots,
within Anthropic's four-breakpoint limit. Reasoning signatures, tool outputs and
other provider metadata remain intact. Cache policy uses the resolved model slug,
not a persisted selector key that may now route to another model family.

Use explicit markers here: a live OpenRouter/Bedrock check sent the documented
automatic top-level directive successfully but did not advance cache writes
through tool results. Explicit result markers did. Do not replace measured
behavior with an assumption that all upstream endpoints implement an option.
Keep the default short TTL; a longer TTL charges more for writes and needs a
separate cost comparison.

Keep fallback lists, ignored providers, privacy restrictions, reasoning settings,
permission-driven tool availability, context limits and pruning independent of
cache hints. Do not retain obsolete permissions or unbounded tool output merely
to improve a hit ratio. The [stopped history pilot](cache-stable-history.md) is
separate and must not be reactivated by these changes.

## Fast checks

`pnpm benchmark:prompt-cache` runs offline SDK serialization and tool-loop
regressions for both streaming and non-streaming requests. It verifies provider
namespaces, history preservation, parallel-tool marker bounds, model isolation
and cache-usage parsing. It reports no live savings and needs no service access.

`pnpm benchmark:prompt-cache:live --model z-ai/glm-5.3-flash` makes six short
synthetic calls: cold start plus two tool-result continuations in each arm. Use
`--pairs 2` for twelve calls with reversed order in the second pair. Other models
can be selected by their actual provider slug, including `abliterated-model-large-flash`.
Only the model API credential is loaded from this checkout or the environment.
The runner never executes tools, loads customer chats or connects to Convex.
It checks that each model returns the latest synthetic tool-result marker.

Results go to `.artifacts/prompt-cache/`. Each request is bounded to 512 output
tokens, 45 seconds, no retries; the run has a six-minute deadline and a $1
reported-cost stopping guard. Missing cost cannot enforce that dollar guard,
so call and token limits remain authoritative. No credentials, full requests or
responses are written. Unknown cache usage/cost remains unknown; explicit zero
counts remain observations. The summary includes cold calls and weights cache
reads by covered input tokens, with coverage reported separately.

Compare per-model arms including failed calls, provider identity, write cost and
answer checks. Separate random early prefixes prevent one arm warming the other.
Different provider routing and output lengths can still confound a short result;
DeepSeek has unchanged cache policy in this comparison and acts as a negative
control for routing and cache variance.
A cache-rate improvement on this fixture is not a production cost estimate.
For release acceptance, use disposable Ask and Agent chats, make two bounded tool
calls, reload/continue and stop a running turn. Check current output and saved
history, provider errors, reported cache reads/writes and total model cost. Check
delegated child continuation and image-model promotion separately.

## Primary references

- [OpenRouter caching and session affinity](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
  describes automatic-cache models, sticky routing and Z.AI session affinity.
- [Abliteration caching](https://docs.abliteration.ai/capabilities/prompt-caching)
  documents its separate affinity field and best-effort retention.
- [Hermes cache planning](https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_caching.py)
  uses bounded rolling breakpoints, request-local decoration and provider-specific
  handling of tool-result markers.
- [DeepSeek Harness summarization](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/summarizer.ts)
  preserves request prefixes for aligned summaries. History/compaction policy is
  separate from request-level cache hints.
- [T3 Code Claude driver](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/ClaudeDriver.ts)
  delegates to the Claude agent runtime; its session architecture is different
  from HackerAI's stateless model requests. Its
  [usage normalization](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/ClaudeTurnTokenUsage.ts)
  also keeps cache-read and cache-write accounting explicit.
- [OpenCode cache lowering](https://github.com/anomalyco/opencode/blob/8bca5329293a34f4bdd7fdc4f4020be80c1eb477/packages/ai/src/protocols/utils/cache.ts)
  enforces provider breakpoint budgets rather than adding unlimited markers.
