# Persistent Agent goals

A goal keeps an objective and completion contract attached to one chat across bounded Agent runs. Typing `/goal` offers a goal composer; `/goal start <objective>` also starts directly. `/goal status`, `/goal pause`, `/goal resume`, `/goal stop`, and `/goal clear` inspect or control the saved goal. Clear removes its visible controls. A normal composer message pauses automatic goal work before it is queued.

The completion contract has one to eight success criteria and optional verification command, constraints to preserve, scope boundaries, and conditions requiring user input. Multiline commands accept `criterion:`, `verify:`, `preserve:`, `scope:`, and `stop when:` fields. The goal bar sits above the composer. Editing opens the Computer sidebar on desktop and its full-screen overlay on mobile, with labeled objective and contract inputs. Saving pauses work, preserves elapsed work time, clears evidence for the old objective, and requires explicit Resume.

Goal messages retain a sent-as-goal receipt. Verified completion saves cumulative active goal time on the final assistant message. Pauses and waiting are excluded; resuming continues from the saved duration. These receipts survive reload, goal deletion, and replacement; ordinary completed runs receive no achievement receipt. Older goals without a recorded start time do not receive an invented duration.

## Limits and completion

Goals have no fixed run-count limit. Each run has up to twenty minutes of active work and remains subject to the existing plan, spend, approval, cancellation, and sandbox limits. Automatic continuations use fresh workers and preserve saved progress. Normal usage exhaustion leaves the goal unfinished and requires explicit resume after usage becomes available. Legacy goals stopped at the old run cap remain paused until the user resumes them; no run extension is needed.

Completion requires saved assistant tool results for every criterion and a separate bounded model check. An optional verification command must finish successfully through the existing terminal and approval path in the final run. Checkpoint explanations alone cannot establish success. The completion check is billed through the run's normal usage settlement. Its failure blocks automatic work for review.

Goals can wait up to thirty minutes before another slice. Two consecutive slices without usable tool results stop for review. These checks bound automatic work; they are not guarantees that every tool result represents useful progress or that model judgment is infallible. The chat retains the evidence for user review.

## Durable lifecycle

Convex owns the goal, generation, work count, progress, and evidence references. Trigger runs claim one generation atomically before performing costly work. Stale or duplicate workers cannot claim it. Pause, edit, and delete remain authoritative when a late worker settles. Deleted goals retain an internal tombstone until replacement so stale generations cannot claim work and interrupted run leases can still reconcile. Goal state survives context compaction because each new run reads the canonical record alongside the existing chat history.

A short dispatcher starts the next normal Agent run only after the preceding run has settled and cleaned up. Continuations retain the original sandbox, model, permission mode, region, Convex URL, and worker version. Approval modes open the existing approval session protocol. Fresh account, suspension, and feature eligibility checks run before each new slice. Failed runs and usage exhaustion require explicit resume.

If a worker terminates before saving its final state, loading goal status reconciles the recorded run against Trigger after checking its chat and user metadata. Reconciliation never infers success from a completed Trigger status. A queued goal whose dispatch could not be reconciled can be paused and explicitly resumed to fence the old generation.

## Rollout and verification

`persistent-agent-goals` gates paid Agent goal admission and continuation. Existing saved goals retain their pause, edit, and delete controls after the flag is disabled. Goal analytics contain identifiers, categorical states, and counts; they exclude objectives, criteria, prompts, commands, and evidence.

`agent_goal_lifecycle` records admission, resume, worker claim, settlement, recovery, user controls, and continuation scheduling/start/failure. `goal_attempt_id` separates replacements of the same goal record; `goal_generation` fences continuations, and `trigger_run_id` joins existing Agent diagnostics. Retried emissions share a deterministic event UUID. Use `snapshot_updated_at` to order persisted state snapshots rather than ingestion time; dispatch observations can arrive after a newer worker snapshot. Cleared goals have `deleted: true`. Failures without a snapshot do not assert a persisted state. `elapsed_ms` uses the same cumulative timer as the UI. Count unique attempts, not settlement events, for outcomes; paused, waiting, input-required, and budget-exhausted states are not infrastructure failures. Telemetry is best effort and cannot fail execution. Missing events alone do not prove a stalled worker; confirm its recorded Trigger run and canonical goal state.

Deploy the Convex functions and Trigger worker before testing goal admission in the web Preview. Independently verify the Vercel, Trigger, Convex, and PostHog selections according to `AGENTS.md`. Preview uses the Developer account and development PostHog project; Production requires a separate rollout decision. A feature-flag definition alone does not prove that the worker uses the expected project.

Acceptance should exercise a real two-run goal, persisted progress after reload, independent completion, a failed verification command, Pause during work, Stop between slices, approval waiting, continuation past the former run limits, no-progress stopping, and safe recovery after a canceled or failed worker. Test a connected local or Desktop sandbox separately from cloud because those transports have different availability and reconnection behavior.

The composer Stop button pauses the saved goal before canceling its active run. Resume stays visible but disabled during cancellation cleanup, then continues from saved progress. Canceled work slices also settle as paused if cleanup wins the race; explicit `/goal stop` and `/goal clear` retain their stopped/deleted semantics.
