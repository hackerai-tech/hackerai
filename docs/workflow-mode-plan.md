# Workflow Mode — Plan

Goal: lift Vercel 800s hard limit on `/api/agent` for long pentest tool runs. Use Vercel Workflow SDK to run agent loop as a durable workflow (hours OK), with native resumable streams.

## Why Workflow SDK

- Each `"use step"` function gets its own fresh function invocation → 800s budget per step, not per request.
- Workflow run survives across invocations; pause/sleep/hook native.
- `getWritable<UIMessageChunk>()` produces durable, resumable, namespaced streams — supersedes current `resumable-stream` glue for agent mode.
- `DurableAgent` from `@workflow/ai` mirrors `streamText` semantics → minimal port of existing logic.

## Current state (relevant)

- `app/api/agent/route.ts` → `createChatHandler("/api/agent")`, `maxDuration = 800`.
- `lib/api/chat-handler.ts` is monolith: auth, rate-limit, system prompt, `streamText`, fallback retry, summarization, doom-loop, resumable-stream wiring, save-on-finish.
- Resumable streams already exist via `resumable-stream` + `/api/chat/[id]/stream` GET, keyed off `chat.active_stream_id`.
- Tools (`createTools`) call sandbox (E2B/local) — already async, fine inside steps.

## Target architecture

```
POST /api/workflow              → start(agentRunWorkflow, [...]) → returns runId + stream
GET  /api/workflow/[runId]      → resume stream (replay from startIndex)
POST /api/workflow/[runId]/stop → events.create(runId, run_cancelled)
POST /api/workflow/[runId]/msg  → resumeHook(token, userMsg)   // optional multi-turn
```

`chat.active_workflow_run_id` Convex field replaces `active_stream_id` for workflow chats.

### Workflow file: `lib/workflows/agent-run.ts`

```ts
"use workflow";
// orchestration only: no fetch, no fs

import { DurableAgent } from "@workflow/ai/agent";
import { getWritable, sleep } from "workflow";
import type { UIMessageChunk } from "ai";

export async function agentRunWorkflow(input: AgentRunInput) {
  "use workflow";
  const writable = getWritable<UIMessageChunk>();

  // pre-flight in step: auth, rate limit, build system prompt, model pick
  const ctx = await prepareAgentRun(input);

  const agent = new DurableAgent({
    model: ctx.modelId, // resolved via step
    system: ctx.systemPrompt,
    tools: buildWorkflowTools(ctx), // each tool.execute is "use step"
    providerOptions: ctx.providerOptions,
  });

  const result = await agent.stream({
    messages: ctx.messages,
    writable,
    maxSteps: ctx.maxSteps,
  });

  await persistFinalState(ctx.chatId, result.messages); // step
  return { messages: result.messages, usage: agent.usage };
}
```

### Steps to extract from chat-handler

Each becomes own `"use step"` function in `lib/workflows/steps/`:

- `prepareAgentRun` — auth, geolocation, rate-limit reservation, model select, system prompt build, message processing/truncation, sandbox provisioning. Returns plain serializable ctx (no functions).
- `executeBashTool`, `executeFileEdit`, `executeReadTool`, … — tool wrappers calling existing sandbox client. Tools survive step retry → idempotency note: bash/exec is **not** idempotent; mark with `maxAttempts: 1` or guard via correlation id stored in sandbox.
- `summarizeIfNeeded` — moves current `runSummarizationStep` here; returns truncated messages.
- `persistFinalState` — `saveMessage`, `updateChat`, `deductUsage`, PostHog flush.
- `refundOnFailure` — dispatched in `try/catch` outside agent.stream.

### Stop conditions → workflow primitives

| Today                                   | Workflow equivalent                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AGENT_MAX_STREAM_DURATION_MS` (~13min) | drop — replace with hard wall, e.g. 60min via `Promise.race(agent.stream, sleep("60m"))` then graceful save |
| `preemptiveTimeout` before Vercel kill  | drop — workflow not bound by 800s                                                                           |
| `doomLoopDetected`                      | keep — implemented inside DurableAgent's `prepareStep`, port nudge logic                                    |
| `tokenExhaustedAfterSummarization`      | keep — same                                                                                                 |
| User stop button                        | `events.create(runId, "run_cancelled")` from stop endpoint; agent observes `getStepMetadata().abortSignal`  |

### Streaming UI

Client (`app/components/chat.tsx`) already consumes `UIMessageChunk` SSE. Two paths:

1. Initial POST returns `{ runId }` + immediate stream pipe of `run.getReadable()`.
2. Reload / disconnect → GET `/api/workflow/[runId]?startIndex=N`. Use namespaced streams: default = UI chunks, `logs:debug` = verbose tool stdout (skip on replay for speed).

`useAutoResume` hook stays — point it at `/api/workflow/[runId]` when `chat.active_workflow_run_id` set.

### Multi-turn within one workflow run (optional, phase 2)

Use iterable hook so the workflow lives across user turns:

```ts
const hook = createHook<{ text: string; done?: boolean }>({
  token: `chat-${chatId}`,
});
for await (const turn of hook) {
  const result = await agent.stream({
    messages: [...prev, { role: "user", content: turn.text }],
    writable,
    maxSteps,
  });
  if (turn.done) break;
}
```

Pro: full session lives hours, no re-warm cost.
Con: client must POST to `/resumeHook` instead of new chat POST. Skip in v1; one-workflow-per-turn is simpler.

## Migration / rollout

1. Install: `pnpm add workflow @workflow/ai @workflow/core @workflow/next @workflow/serde`.
2. Wire `withWorkflow` in `next.config.*` per `node_modules/workflow/docs/getting-started/next.mdx`.
3. Add `lib/workflows/agent-run.ts` + steps; reuse existing `createTools`, `systemPrompt`, db actions verbatim inside steps.
4. New endpoints under `app/api/workflow/`. Leave `/api/agent` untouched.
5. Add `chat.active_workflow_run_id` to Convex schema; client mode toggle: `agent` (current) vs `workflow` (new long-run).
6. Feature-gate by subscription `pro+` and behind UI toggle ("Long-run workflow mode").
7. Observability: `npx workflow web` + Axiom logger calls inside steps (Node.js available).

## Open questions / risks

- **Step idempotency for shell commands** — Workflow retries failed steps. Wrap each command in a step that records a tx-id in the sandbox before execution; on retry, check tx-id and short-circuit. Or set step retry policy to 0.
- **Tool latency budget** — single `tool.execute` step still bound by serverless 800s. Long nmap/ffuf must be split into "start scan" + `sleep("30s")` poll loop + "fetch results" steps. Pattern: `start_command_async` → returns pid; `wait_command` polls until done with `sleep`.
- **Provider key handling** — `prepareAgentRun` step resolves BYOK; passes plain key string into `DurableAgent` via `model` config. Confirm `@workflow/ai` accepts custom provider/header injection like AI SDK does.
- **Cost** — DurableAgent persists every step's I/O; verbose tool output bloats storage. Use namespaced streams for stdout, return only summaries from tool steps.
- **Workflow SDK version pinning** — bundled docs in `node_modules/workflow/docs/` are source of truth; verify before coding.

## V1 (landed in this PR)

- `lib/workflows/agent-run.ts` — `agentRunWorkflow` using `DurableAgent` (default model `anthropic/claude-sonnet-4-5` via Vercel AI Gateway).
- `lib/workflows/steps/sandbox-steps.ts` — `"use step"` wrappers: `startSandbox`, `killSandbox`, `runCommandStep`, `startCommandAsync`, `pollCommandAsync`, `readFileStep`, `writeFileStep`. Each step gets its own ~800s budget; long scans use start/poll pattern with workflow `sleep`.
- Endpoints under `app/api/workflow/`:
  - `POST /api/workflow` — auth + pro-gate, calls `start(agentRunWorkflow, [...])`, returns `{ runId }`.
  - `GET  /api/workflow/[runId]` — returns `{ runId, status, exists }`.
  - `GET  /api/workflow/[runId]/stream?startIndex=N` — pipes `run.getReadable({ startIndex })` as SSE for resumable consumption.
  - `POST /api/workflow/[runId]/stop` — calls `run.cancel()`.
- `next.config.ts` wrapped with `withWorkflow()`.

Required env: `E2B_TEMPLATE_ID`, plus `AI_GATEWAY_API_KEY` (or Vercel-hosted gateway) for the default model.

Quick smoke (after `pnpm dev`):

```bash
curl -X POST http://localhost:3000/api/workflow \
  -H 'Content-Type: application/json' --cookie "$AUTHKIT_COOKIE" \
  -d '{"chatId":"test-1","prompt":"Run nmap -sV -A scanme.nmap.org and summarize open services."}'
# -> {"runId":"..."}

curl -N http://localhost:3000/api/workflow/<runId>/stream --cookie "$AUTHKIT_COOKIE"
```

## Phase 1 deliverables (1-2 weeks)

- `agentRunWorkflow` with 4-5 core tools ported as steps.
- POST/GET/STOP endpoints.
- Schema migration + UI mode toggle.
- Smoke test: 30-minute nmap scan completing successfully and resumable across browser refresh.

## Phase 2

- Multi-turn iterable hook session.
- Step idempotency layer.
- Long-running tool start/poll/finish pattern as a reusable helper.
