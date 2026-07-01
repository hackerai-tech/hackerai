# Migration to DeepSeek

HackerAI's AI integration was rewritten to talk **exclusively** to the DeepSeek
API (`https://api.deepseek.com`), using its OpenAI-compatible chat completions
endpoint via the `@ai-sdk/openai` provider. OpenRouter (the previous
multi-provider router) and the standalone OpenAI moderation call have been
removed. This document explains what changed, why, and how to run and
configure the app going forward.

## How to run the app

```bash
pnpm install
pnpm run setup      # interactive .env.local generator (now only asks for DeepSeek + E2B keys)
pnpm run dev        # or: pnpm run dev:next / pnpm run dev:convex / pnpm run dev:trigger
```

## How to configure `.env`

Copy `.env.local.example` to `.env.local` and fill in:

```bash
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com   # optional, this is the default
DEEPSEEK_MODEL=deepseek-v4-flash             # optional, this is the default
```

- `DEEPSEEK_API_KEY` is **required** — read only from the environment, never
  hardcoded.
- `DEEPSEEK_BASE_URL` is optional. Point it at a different OpenAI-compatible
  endpoint (self-hosted proxy, regional endpoint, etc.) if needed.
- `DEEPSEEK_MODEL` is optional. Set it to any model DeepSeek exposes on its
  OpenAI-compatible API (e.g. `deepseek-chat`, `deepseek-reasoner`,
  `deepseek-v4-pro`). Every chat/agent request uses this one model — no model
  name is hardcoded anywhere in the code except the `deepseek-v4-flash`
  fallback default.

If you also run the Trigger.dev worker for Agent Long mode, add the same
`DEEPSEEK_API_KEY` (and `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL` if overridden) to
the Trigger.dev dashboard's environment variables, since the task runs on
Trigger.dev's infrastructure, not on the Next.js server.

## How to change the model or base URL

Just edit the environment variables — no code changes needed:

```bash
DEEPSEEK_MODEL=deepseek-reasoner
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Restart the dev server (and redeploy/update the Trigger.dev worker's env vars
if applicable) for the change to take effect.

## What changed and why

### Core provider client

- **`lib/ai/providers.ts`** (rewritten) — replaced `createOpenRouter` +
  per-tier OpenRouter model slugs (Anthropic Claude, xAI Grok, Google Gemini,
  MiniMax, Moonshot Kimi, DeepSeek-via-OpenRouter) with a single
  `createOpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL })`
  client and one `deepseek(DEEPSEEK_MODEL)` language model. Every existing
  registry key (`ask-model`, `agent-model`, `model-sonnet-4.6`,
  `model-opus-4.6`, etc.) now points at that same DeepSeek model — the key
  _names_ were kept because usage tracking, rate limiting, and cost
  accounting elsewhere key off of them (the app's Standard/Pro/Max tier
  system is unchanged; all tiers just run on DeepSeek now). Removed the
  OpenRouter-specific request-patching helpers (`sanitizeOpenRouterRequestForXai`,
  `sanitizeOpenRouterRequestForGeminiFunctionResponses`,
  `patchKimiReasoningToolCalls`, attribution headers) and the
  `isAnthropicModel`/`isKimiModel`/`isMiniMaxModel`/`isGeminiModel` helpers,
  since no other provider exists anymore. `isDeepSeekModel` now always
  returns `true`; `supportsMultimodalToolResults` now always returns `false`
  (DeepSeek's chat completions API does not return multimodal tool results).

### Removed: OpenRouter-only plumbing

OpenRouter's automatic cross-provider model fallback, routing metadata, and
generation-id lookups have no equivalent with a direct single-provider API,
so this was deleted rather than adapted:

- `lib/ai/openrouter-attribution.ts` — removed (OpenRouter attribution headers).
- `lib/api/openrouter-metadata.ts` + its test — removed (parsed OpenRouter's
  routing/generation-id response metadata).
- `scripts/check-openrouter-gen-id.ts` — removed (dev utility for OpenRouter
  generation IDs).
- `lib/api/chat-stream-helpers.ts` — removed `MODEL_FALLBACK_CHAIN` and all
  per-model fallback-chain constants, `buildSystemPrompt`/
  `addCacheBreakpointToLastUserMessage` (Anthropic prompt-cache breakpoints),
  and the OpenRouter `reasoning`/`models`/`user` provider-options builder.
  `getRetryFallbackModel` now returns the same model (there's nothing else to
  fall back to); `resolveServedModelForCostAccounting` now just compares the
  response model id to the requested one; `buildProviderOptions` now returns
  `{}` since DeepSeek's OpenAI-compatible API takes no extra per-request
  provider options today.
- `lib/api/agent-stream-runner.ts` — removed the OpenRouter metadata
  extraction/merge calls in `onFinish`, the `isXaiSafetyError` fallback-metadata
  gate in `onError`, and the Anthropic-message-repair branch in
  `prepareProviderMessages` (now a straight pass-through).
- `lib/chat/compaction/prune-tool-outputs.ts` — removed
  `repairAnthropicModelMessagesWithTelemetry`/`repairAnthropicModelMessages`
  and the `PromptMessage`/`AnthropicPromptRepair*` types (Anthropic-only
  assistant-prefill workaround, unused with DeepSeek).
- `lib/logger.ts` / `lib/api/chat-logger.ts` — removed the `openrouter_*`
  fields from the wide-event schema, `setOpenRouterMetadata`,
  `recordModelFallback`, and `recordAnthropicPromptRepair`; `setStreamResponse`
  no longer takes an OpenRouter metadata argument.
- **`lib/api/chat-handler.ts`** / **`trigger/agent-long.ts`** — updated the two
  `resolveServedModelForCostAccounting(...)` call sites to match the
  simplified signature (no `mode` argument needed anymore).

### Removed: OpenAI content moderation

DeepSeek has no equivalent to OpenAI's dedicated Moderation API, and keeping
a separate `OPENAI_API_KEY` around just for moderation would contradict
"exclusively DeepSeek." This feature (and the app's "authorization disclaimer"
that only existed to react to its verdict) was removed entirely:

- `lib/moderation.ts` + test — removed.
- `lib/chat/auth-disclaimer.ts` + test — removed (language detection was only
  used to localize the moderation-gated disclaimer text).
- **`lib/chat/chat-processor.ts`** — removed the `getModerationResult`/
  `addAuthMessage` call in `processChatMessages`, and the now-dead
  `stripProviderMetadata`/`isAnthropicModel` branch.
- **`app/trust/page.tsx`** — updated the privacy/trust copy to describe
  DeepSeek as the sole model provider and dropped the "OpenAI — content
  moderation" subprocessor entry.

### UI

- **`app/components/ModelSelector/constants.ts`** — the Standard/Pro/Max tier
  picker (for both Ask and Agent modes) is unchanged structurally, but every
  `poweredBy` label now reads "DeepSeek" instead of Claude/Grok/MiniMax, since
  every tier runs the same DeepSeek model under the hood.

### Config / docs / dependencies

- **`.env.local.example`**, **`scripts/setup.ts`** — replaced
  `OPENROUTER_API_KEY` / `OPENAI_API_KEY` with `DEEPSEEK_API_KEY` (required),
  `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` (both optional, defaults shown above).
  The interactive setup script now only prompts for a DeepSeek key (it
  previously also prompted for an unused `XAI_API_KEY`, which has been
  dropped).
- **`README.md`** — updated the prerequisites list and the Trigger.dev worker
  env var instructions.
- **`package.json`** / **`pnpm-lock.yaml`** — removed `@openrouter/ai-sdk-provider`,
  `@posthog/ai` (was already unused/disabled), the `openai` npm package (only
  used by the removed moderation call), and `franc-min` (only used by the
  removed language detector). Kept `@ai-sdk/openai`, which now does the real
  work of talking to DeepSeek.

### Tests updated to match

- `lib/ai/__tests__/providers.test.ts` — rewritten to assert every registry
  key resolves to the configured DeepSeek model and that
  `supportsMultimodalToolResults`/`isDeepSeekModel` reflect the new
  always-false/always-true behavior (dropped tests for the removed
  OpenRouter xAI/Gemini request-sanitizers).
- `lib/api/__tests__/chat-stream-helpers-fallback.test.ts` — rewritten for
  the simplified `buildProviderOptions`/`getRetryFallbackModel`/
  `resolveServedModelForCostAccounting` behavior.
- `lib/api/__tests__/chat-logger.test.ts` — updated the two assertions that
  referenced `openrouter_generation_id` / OpenRouter provider metadata.
- `lib/ai/tools/__tests__/file.test.ts` — the sandbox-image "view" action
  test scenarios were rewritten: since DeepSeek doesn't support multimodal
  tool results, viewing images through the file tool is no longer available
  for _any_ model (previously it worked for Kimi/MiniMax/etc. via OpenRouter).
  The tests now confirm the tool degrades gracefully with an explicit
  "does not support multimodal tool results" message instead of silently
  failing.
- `lib/chat/__tests__/chat-processor.test.ts`,
  `lib/chat/compaction/__tests__/prune-tool-outputs.test.ts` — removed tests
  for the deleted `addAuthMessage` and `repairAnthropicModelMessages` helpers.

## What did _not_ change

- The chat/agent streaming pipeline (`streamText`, `prepareStep`, tool
  calling, `stopWhen`, doom-loop detection, summarization, budget monitoring)
  is untouched — only the model it points at changed.
- The Standard/Pro/Max subscription-tier system, rate limiting, usage
  tracking, and Stripe billing are untouched.
- Perplexity (web search tool) and Jina AI (URL content retrieval) remain as
  optional tool integrations — they are agent _tools_, not the chat/agent
  language model, and are unaffected by this migration.
- `lib/chat/provider-metadata-sanitizer.ts` (strips `reasoning_details`/
  `encrypted_content` blobs OpenRouter attached to persisted messages) was
  left in place. It is now effectively a no-op for new messages (DeepSeek's
  responses don't carry that shape) but still safely cleans up
  already-persisted messages from before the migration.
- `@langchain/community` / `langchain` were left alone — they're used for
  CSV file parsing (`convex/fileActions.ts`), unrelated to the AI chat
  provider.

## Known limitation introduced by this migration

Sandbox image viewing via the file tool's `view` action requires a
multimodal-capable model. DeepSeek's chat completions API does not return
multimodal tool results, so this action is currently unavailable regardless
of which tier is selected (it degrades gracefully with an explanatory error
instead of failing silently). All other tools — reading/writing/editing
files, terminal/code execution, web search, notes, HTTP proxy, etc. — are
unaffected.
