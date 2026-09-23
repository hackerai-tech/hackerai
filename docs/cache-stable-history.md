# Cache-stable model history

The experiment is owned and reviewed in [HAC-129](https://linear.app/hackerai/issue/HAC-129/implement-cache-stable-model-history-and-prefix-aligned-compaction).
It optimizes reusable model input, not application response caching. Stable
requests make provider cache reuse possible; they do not guarantee a cache hit
or a lower total cost.

## Invariants and boundaries

`cache_stable_history_v1` enables the shared Ask/Agent treatment for text-only
DeepSeek v4 routes. Missing/disabled flags keep the existing behavior. Each
prepared request becomes an immutable checkpoint; later tool results and context
updates append to it. Note deletion is an explicit empty snapshot. Ordinary tool
output pruning is deferred until existing context-pressure gates fire; context
limits and bounded compaction attempts still apply.

Completed turns may save one private model-facing snapshot, separate from UI
history. Resume requires the entire saved source prefix and the current model,
mode, subscription, authorization, notes preference, system instructions and
ordered tool schemas to match. Only the date may change without invalidating the
system snapshot; its current value is appended instead. Important policy changes
must never be normalized away. Bump the snapshot version for incompatible
model-facing policy or serialization changes not represented by this identity.

Only an exact backend-owned prefix retains trusted authorization annotations.
Every new suffix still passes through the current authorization sanitizer. UI
history and newly submitted messages never acquire trust from matching tag text.
Authorization or tool changes invalidate replay rather than freezing permissions.

Storage is service-authenticated, owner-checked and bounded to 700,000 UTF-8
bytes per chat. Source digests and prompt contents stay in private storage, never
analytics. Chat deletion deletes the snapshot; edits/regeneration invalidate it.
Revision claims fence older workers and post-edit writes. Snapshots are not copied
to shared or branched chats. Missing storage, corrupt snapshots, unsupported media
or incompatible history fall back safely. Oversized or interrupted turns do not
save a new snapshot; exact replay of interrupted work is not promised.
Replay storage waits have a 1.5-second deadline. Saves run after accounting and
cleanup, using the caller's background-work registrar when available. A deadline
does not cancel an already submitted database mutation; revision/ownership checks
remain authoritative for late writes. Failed notes lookups preserve the last known
state rather than emitting a false deletion.

## Separate summarization treatment

`cache_aligned_summary_v1` additionally permits **in-run** summarization with the
current DeepSeek model, frozen system, last active tool schemas and unchanged
history followed by a summary instruction. The full prefix must fit after system,
schema and instruction/output headroom. Otherwise the existing bounded summary
ladder is used, including after non-cancellation warm-summary failures. Tool execution is disabled, output is bounded, cancellation is
respected, and empty/truncated summaries cannot replace history. The existing
startup-compaction ladder is unchanged.

This follows [DeepSeek's aligned summarization](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/compaction/compaction-basic/src/summarizer.ts)
and append-only context approach, and [Hermes's private API-content replay](https://github.com/NousResearch/hermes-agent/blob/6159bf4d87a32de72869e0b479606ddd2b9977a1/tests/agent/test_api_content_sidecar.py)
and frozen prompt snapshots. It does not copy their thresholds or claim their
reported savings transfer to HackerAI.

## Rollout and verification

Deployment does not activate either flag. Configure Preview and Production
separately under the environment rules in AGENTS.md; Production activation needs
an explicit staged rollout decision. Deploy the Convex schema/functions before
enabling the application treatment. Verify the actual Trigger worker's project,
not only Vercel's. Flag evaluation happens at the start of a new model stream;
disable flags to roll back subsequent streams without a code deployment.

Start with history only. `cache_stable_history_exposed` records actual execution
and whether compatible saved history was restored; `cache_aligned_summary_exposed`
records actual warm-summary selection. Neither exports content or content hashes.
Compare token-weighted cache reads and cost per started/successful run alongside
completion, errors, latency, compaction frequency and summary quality. An improved
hit ratio alone is not a release criterion. Review before adding the summary
treatment or expanding the cohort; HAC-129 owns readout and flag removal.

Before rollout, use disposable chats in the verified Preview environment:

- Test Ask and Agent with flags off, history only, then both flags on. Run a short
  multi-tool task, update/delete a note, and verify the latest state is respected.
- Reload and continue; confirm replay-restored exposure and coherent context.
  Edit/regenerate, change model/permissions, and stop/retry: old snapshots must
  not override the new task, policy or cancellation.
- Trigger bounded context pressure; verify a complete summary and continuation,
  fallback for an over-budget prefix, and unchanged startup compaction behavior.
- Exercise cloud and local/desktop Agent transports; delete the disposable chat
  and confirm no private history remains. Check provider usage/cost and ensure
  analytics contain no prompt, tool-output or target content.

SDK regression tests use synthetic providers and prove request/reconstruction
invariants. They are not live-provider cache or end-to-end deployment evidence.
