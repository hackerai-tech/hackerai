# Persistent Agent goals

A goal keeps an objective and completion contract attached to one chat across bounded Agent runs. The user can set it from the goal panel or with `/goal start <objective>`. `/goal`, `/goal pause`, `/goal resume`, and `/goal stop` show or control the saved goal. A normal composer message pauses automatic goal work before it is queued.

The completion contract has one to eight success criteria and optional verification command, constraints to preserve, scope boundaries, and conditions requiring user input. Multiline commands accept `criterion:`, `verify:`, `preserve:`, `scope:`, `stop when:`, and `runs:` fields. The panel exposes the same contract with labeled inputs.

## Limits and completion

The default budget is three runs. Each run has up to twenty minutes of active work and remains subject to the existing plan, spend, approval, cancellation, and sandbox limits. The goal has a cumulative maximum of eight runs. Resuming preserves the used-run count; an exhausted budget requires an explicit extension such as `/goal resume +2`. A limit leaves the goal unfinished.

Completion requires saved assistant tool results for every criterion and a separate bounded model check. An optional verification command must finish successfully through the existing terminal and approval path in the final run. Checkpoint explanations alone cannot establish success. The completion check is billed through the run's normal usage settlement. Its failure blocks automatic work for review.

Goals can wait up to thirty minutes before another slice. Two consecutive slices without usable tool results stop for review. These checks bound automatic work; they are not guarantees that every tool result represents useful progress or that model judgment is infallible. The chat retains the evidence for user review.

## Durable lifecycle

Convex owns the goal, generation, budget, progress, and evidence references. Trigger runs claim one generation atomically before performing costly work. Stale or duplicate workers cannot claim it. Pause and Stop remain authoritative when a late worker settles. Goal state survives context compaction because each new run reads the canonical record alongside the existing chat history.

A short dispatcher starts the next normal Agent run only after the preceding run has settled and cleaned up. Continuations retain the original sandbox, model, permission mode, region, Convex URL, and worker version. Approval modes open the existing approval session protocol. Fresh account, suspension, and feature eligibility checks run before each new slice. Failed runs and usage exhaustion require explicit resume.

If a worker terminates before saving its final state, loading goal status reconciles the recorded run against Trigger after checking its chat and user metadata. Reconciliation never infers success from a completed Trigger status. A queued goal whose dispatch could not be reconciled can be paused and explicitly resumed to fence the old generation.

## Rollout and verification

`persistent-agent-goals` gates paid Agent goal admission and continuation. Existing saved goals retain their Pause and Stop controls after the flag is disabled. Goal analytics contain identifiers, categorical states, and counts; they exclude objectives, criteria, prompts, commands, and evidence.

Deploy the Convex functions and Trigger worker before testing goal admission in the web Preview. Independently verify the Vercel, Trigger, Convex, and PostHog selections according to `AGENTS.md`. Preview uses the Developer account and development PostHog project; Production requires a separate rollout decision. A feature-flag definition alone does not prove that the worker uses the expected project.

Acceptance should exercise a real two-run goal, persisted progress after reload, independent completion, a failed verification command, Pause during work, Stop between slices, approval waiting, explicit budget extension, and safe recovery after a canceled or failed worker. Test a connected local or Desktop sandbox separately from cloud because those transports have different availability and reconnection behavior.
