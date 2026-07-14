# Agent Mode `chat.agent` Migration Plan

## Goal

Move HackerAI Agent mode toward Trigger.dev `chat.agent` and Head Start without treating it as a drop-in transport swap. The current `agent-long` path stays as the rollback path until parity is proven for solo-user Agent activation: fast first token, reliable resume, clear limits, desktop/local sandbox support, file uploads, and cost accounting.

Trigger.dev's AI chat docs frame `chat.agent` as a session-based task surface. Head Start only pays off when the warm route-handler bundle imports schema-only tools; heavy execute implementations must live in the agent/task bundle.

## Current Custom Path

Start route: `app/api/agent-long/route.ts`

- Authenticates the user with `getUserIDAndPro`.
- Enforces suspension and free Agent gates.
- Normalizes selected model overrides and continuation model policy.
- Persists the initial chat/user message through `handleInitialChatAndUserMessage`.
- Handles desktop-local attachment preparation before triggering the task.
- Triggers `agent-long` with subscription-aware Trigger priority, tags, metadata, region, and public run token.
- Stores `active_trigger_run_id` through `setActiveTriggerRun`.

Task: `trigger/agent-long.ts`

- Rehydrates persisted messages from Convex.
- Processes files and local desktop attachments.
- Builds tools with `createTools`.
- Sets sandbox context and local/E2B fallback reminders.
- Checks rate limits, free concurrency, monthly budgets, extra usage, and refunds.
- Runs the shared Agent loop from `lib/api/agent-stream-runner.ts`.
- Handles fallback models, image-tool-result retry, budget stops, title generation, todo merge, file metadata, usage accounting, analytics, and persistence.
- Writes Trigger metadata/tags for dashboard diagnosis.
- Cleans up PTY sessions and refunds on cancel/error.

Transport and UI: `lib/chat/agent-long-transport.ts`, `app/components/chat.tsx`

- Starts the task via `/api/agent-long`.
- Reads Trigger's durable `ui` stream directly and re-encodes it for `useChat`.
- Replays streams on reload through `/api/agent-long/resume`.
- Cancels stale realtime readers on stop and chat switch.
- Reconciles completed runs that miss a terminal UI chunk.

Resume/cancel: `app/api/agent-long/resume/route.ts`, `app/api/agent-long/cancel/route.ts`

- Verifies chat ownership.
- Retrieves/clears `active_trigger_run_id`.
- Mints run-scoped public access tokens.
- Cancels Trigger runs best-effort and compare-clears stored run IDs.

Shared execution loop: `lib/api/agent-stream-runner.ts`

- Owns the canonical multi-step `streamText` behavior for `/api/chat` and `agent-long`: prepare step, summarization, prompt pressure, stop conditions, provider diagnostics, doom-loop recovery, budget aborts, fallback telemetry, PTY cleanup, and usage accumulation.

Tool execution: `lib/ai/tools/**`

- Tool schemas are now available from `lib/ai/tools/schemas.ts`.
- Heavy `execute` functions still live in the existing tool modules and are assembled by `lib/ai/tools/index.ts`.

## Target Shape

1. Keep `agent-long` unchanged as the default production path.
2. Add a separate `trigger/chat-agent.ts` proof that defines a `chat.agent` using the existing shared Agent runner where practical.
3. Add server helpers for session start/access tokens rather than using run-scoped tokens directly.
4. Add a Head Start route handler that imports only:
   - `@trigger.dev/sdk/chat-server`
   - `ai`
   - provider/model routing needed for step 1
   - `lib/ai/tools/schemas.ts`
   - light auth/session context
5. Keep step 1 text-only handoff behavior behind a feature flag until tool-call handover, persistence, billing, sandbox setup, and resume semantics are verified.

## Staged Rollout

Phase 1: schema split

- Keep existing runtime behavior.
- Make tool definitions importable without sandbox, DB, native, Trigger task, or execute dependencies.
- Guard the import boundary with source-level tests.

Phase 2: non-user-facing proof

- Add a hidden `chat.agent` task and session start/access-token helpers.
- Reuse current auth and suspension checks.
- Reuse `createAgentStream` or extract another small adapter if `chat.toStreamTextOptions()` requires different wiring.
- Do not route production users to it.

Phase 3: Head Start proof

- Add a feature-gated Head Start route for first turn only.
- Run step 1 with the same selected model/provider settings as the agent task.
- Use schema-only tools in the route and full execute tools in the Trigger agent.
- Verify handoff on `tool-calls` and skip on pure-text finish.

Phase 4: parity shadow and limited rollout

- Compare current `agent-long` and `chat.agent` for:
  - first chunk and completion signals
  - reload resume
  - stop/cancel cleanup
  - desktop and local sandbox attachments
  - generated files and file metadata
  - billing, refunds, extra usage, and budget pauses
  - provider fallback and model accounting
  - todo persistence
  - regenerate and auto-continue
- Roll out to a small server-side cohort only after all parity checks pass.

## Rollback

- Leave `shouldUseAgentLongForAgent` and `/api/agent-long` as the production default until rollout.
- Gate all `chat.agent`/Head Start routing behind a kill switch.
- Keep Convex `active_trigger_run_id` cleanup independent from any new session IDs until migration has an explicit data contract.
- On failure, disable the flag and keep existing `agent-long` runs/resume/cancel behavior untouched.

## Open Risks

- Head Start route bundle bloat if tool schemas import execution code transitively.
- Different session identity model from today's `active_trigger_run_id`.
- Step 1 Head Start may bypass current persistence/accounting hooks unless wired explicitly.
- Current desktop-local attachment staging happens in the start route; a light Head Start route cannot import that staging path unchanged.
- `chat.toStreamTextOptions()` may own prepare-step behavior that overlaps with HackerAI's existing summarization and prompt-reminder logic.
- Handoff needs careful validation for tool calls, custom `data-*` parts, and file metadata parts.
