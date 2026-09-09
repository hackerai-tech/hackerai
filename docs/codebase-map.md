# Codebase map

HackerAI is a pnpm workspace: a Next.js app at the root, a Convex backend,
Trigger.dev workers, and local/desktop clients in `packages/`. Start with the
paths for your task; tests usually live in the adjacent `__tests__/` directory.

## Where to change things

| Task                                   | Start here                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Chat UI and message rendering          | `app/components/chat.tsx`, `app/components/`, `app/hooks/useChatHandlers.ts`        |
| Client state                           | `app/contexts/`, `app/hooks/`; generic layout hooks in `hooks/`                     |
| Shared UI primitives                   | `components/ui/`; AI rendering in `components/ai-elements/`                         |
| Ask requests                           | `app/api/chat/route.ts` → `lib/api/chat-handler.ts`                                 |
| Agent dispatch and lifecycle endpoints | `app/api/agent/` → `lib/api/agent-trigger-route.ts`                                 |
| Durable Agent execution                | `trigger/agent-long.ts`; shared model streaming in `lib/api/agent-stream-runner.ts` |
| Subagents                              | `trigger/subagent.ts`, `lib/ai/subagents/`, `convex/subagents.ts`                   |
| Model routing and tools                | `lib/ai/providers.ts`, `lib/ai/tools/`, `lib/chat/agent-routing.ts`                 |
| Prompts, context, and compaction       | `lib/system-prompt/`, `lib/chat/compaction/`, `lib/chat/summarization/`             |
| Database and persistence               | `convex/schema.ts`, `convex/`, `lib/db/actions.ts`                                  |
| Auth and account lifecycle             | `lib/auth/`, `app/api/workos/`, `app/api/delete-account/`, `proxy.ts`               |
| Billing, allowances, and limits        | `lib/billing/`, `lib/pricing/`, `lib/rate-limit/`, `app/api/subscription/webhook/`  |
| Analytics and experiments              | `lib/analytics/`, `lib/posthog/`, `lib/experiments/`, `docs/internal/`              |
| File storage and uploads               | `lib/storage/`, `app/hooks/useFileUpload.ts`, `convex/s3Actions.ts`                 |
| Sandbox transports                     | `lib/ai/tools/utils/`, `lib/centrifugo/`                                            |
| Local sandbox client                   | `packages/local/src/`; setup in `packages/local/README.md`                          |
| Desktop app and bridge                 | `packages/desktop/src-tauri/`, `app/services/desktop-sandbox-bridge.ts`             |
| Sandbox images                         | `docker/`, `e2b/`; setup in `e2b/README.md`                                         |
| Developer tooling and CI               | `scripts/`, `scripts/README.md`, `.github/workflows/`                               |

## Boundaries that matter

- `/api/agent-long` is a compatibility endpoint for the shared Agent route
  implementation. Make shared endpoint changes in `lib/api/`, rather than
  maintaining separate implementations under both route trees.
- Next.js chat handling and Trigger Agent execution share
  `lib/api/agent-stream-runner.ts`. Check both callers when changing streaming,
  retries, usage accounting, or finalization.
- Vercel, Trigger.dev, Convex, and PostHog select environments independently.
  Verify the intended targets before running service commands. Local checks do
  not need a cloud deployment; see the worktree rules in `AGENTS.md`.
- `convex/_generated/`, desktop `src-tauri/gen/`, and the
  `lib/ai/subagents/skills/strix-skill-*.generated.json` files are generated.
  Use their generators rather than editing output. Strix source and provenance
  live in `third_party/strix-skills/`; synchronize with `pnpm skills:sync:strix`.
- Repository coding skills live in `.agents/skills/`. The `.claude/skills/`,
  `.cursor/skills/`, and `.github/skills/` entries link to that source. These are
  separate from the product's runtime subagent skills in `lib/ai/subagents/`.
  Cursor's basic task, advanced task, and configuration rules also point to the
  shared Trigger.dev references while retaining their file-matching metadata.

## Validate the affected area

Install dependencies in this checkout with
`corepack pnpm install --frozen-lockfile`, then run
`pnpm check:local-dependencies`. See `README.md` for service setup when a task
actually needs a running app.

| Change                                | Check                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- |
| TypeScript                            | `pnpm typecheck`                                                          |
| A specific Jest suite                 | `pnpm exec jest --runInBand --runTestsByPath path/to/file.test.ts`        |
| Tests related to changed source files | `pnpm exec jest --runInBand --findRelatedTests path/to/source.ts`         |
| Lint changed app/library files        | `pnpm exec eslint path/to/file.ts` (or `.tsx`)                            |
| Formatting                            | `pnpm exec prettier --check path/to/file`                                 |
| Full CI test command                  | `pnpm test:ci` (Strix sync check, Jest coverage, research runner tests)   |
| Runtime Strix skill sources           | `pnpm skills:sync:strix:check`                                            |
| Local sandbox client                  | `pnpm --filter @hackerai/local build`                                     |
| Browser journeys                      | Follow `e2e/README.md`; run `pnpm test:e2e` with configured test services |

`pnpm lint` covers `app`, `lib`, `types`, and `__mocks__`; it does not lint every
workspace. Choose checks for the files you changed. User-visible chat or Agent
changes also need a bounded request through the affected path and verification
of completion and reconnect behavior, as described in `AGENTS.md`.

For documentation-only changes, check links, referenced paths, and formatting;
starting services or building the application is unnecessary.

## Feature explanations

- Agent approval and auto review: [agent-auto-review.md](agent-auto-review.md)
- Startup compaction: [agent-startup-compaction.md](agent-startup-compaction.md)
- Provider recovery: [provider-error-recovery.md](provider-error-recovery.md)
- Payment recovery: [payment-method-recovery.md](payment-method-recovery.md)
- Cost synchronization: [platform-cost-sync.md](platform-cost-sync.md)
- Customer research: [internal/user-research.md](internal/user-research.md)

Use feature docs to understand intent, then verify current behavior in the
implementation and tests. Keep new guidance near its owning feature and link
it here only when it provides a useful starting point.
