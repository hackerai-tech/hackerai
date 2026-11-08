# Offline usefulness and task-progress benchmark

The current decision protocol is [TASK-PROGRESS.md](TASK-PROGRESS.md). Usefulness
and advancing the user's task decide prompt changes. Latency and company spend
remain operational measurements, with no speed or price threshold for promotion.
The earlier 40-case comparison remains historical evidence under its original
protocol; do not retroactively regrade it under the new criteria.

This is an isolated synthetic evaluation. It does not call HackerAI APIs, read
customer conversations, emit analytics, or change flags, preferences, billing or
deployments. Preparation and tests are offline. `run` is the explicit paid
Development-provider step. The baseline is the checkout's literal system prompt,
actual context builder, tool renderer, stop gate and parser. The manifest pins
source/configuration hashes. This compares prompts on the same model route, not
complete application delivery or real customer outcomes.

`task-progress-fixtures.json` contains fresh tuning/reserved-test scenarios and
reviewer-only goals/criteria. `fixtures.json` retains the older regression set for
compatibility; it is not the new reserved test set. `candidate.txt` is the
benchmark comparison arm. After promoting a tested revision, it can match the
application prompt, as it does at this revision: a fresh run would compare the same
system text. Edit the candidate before a new comparison. To repeat an earlier
comparison, use its original plan and pinned source/configuration, including
`baselineCommit` and recorded source hashes. Preparation during development may
include uncommitted runner/fixture changes; preserve those alongside the plan.
A successful run never automatically promotes a candidate.

## Prepare and run

Use a fresh absolute output directory outside the checkout:

```sh
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts prepare /private/tmp/progress-tuning tuning task-progress
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts run /private/tmp/progress-tuning
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts review /private/tmp/progress-tuning
```

`prepare` writes `plan.json` with balanced paired requests and a frozen manifest.
`run` requires an explicitly supplied approved Development `OPENROUTER_API_KEY`
in the process environment and `SUGGESTION_BENCH_LIVE=development`. It never loads
an env file, application services or backend credentials. Keep credentials out of
command arguments, shell history and output. Results must remain outside the repo;
the path guard rejects the checkout root, descendants and symlinks into it.

The run stops on the first unknown-cost request or $0.50 known provider spend.
One in-flight request can cross that watch limit; it is not a provider-enforced cap.
Every attempted request gets a receipt. Preserve any valid price receipt carried
by a structured-output failure. Missing USD is unknown, not zero. A zero-call stop
has zero provider cost and null tokens/model; saved restoration is not generation.

`review` exports anonymous shuffled drafts, contexts and per-case criteria without
arm, timing or cost. The plan contains the unblinding map and should be kept away
from reviewers. Complete two independent reviews and adjudicate factual concerns
before deciding on a reserved-set result. Reviewer transport/format failures may
be repaired without selecting between valid scores; retain billed failed attempts
and keep all generation outputs and cases. Numeric scores are model evaluations,
not human ratings. Do not award success to absent drafts when continuation is needed.

For reproducible analysis, save completed independent reviews as `grok-scores.json`
and `glm-scores.json`, with anonymous IDs and task-progress/usefulness scores from
the registered rubric. Preserve failed evaluator receipts in `failedAttempts`.

```sh
python3 scripts/benchmarks/suggestions/analyze-progress.py /private/tmp/progress-tuning
```

The analyzer validates complete ID coverage and score/price types, keeps whole
scenarios paired across arms/repeats/reviewers, and resamples scenarios for the
interval. It excludes finished tasks from the primary progress average while
reporting unwanted follow-ups separately. It reports flags for review and never
promotes a prompt. Missing/incomplete evaluator results make the decision incomplete.

After tuning, freeze the chosen candidate before generating the reserved `holdout`
split. Do not revise it after seeing those results and call the same cases reserved.
Keep raw outputs, reviews, receipts and analysis private outside the checkout.
Provider-path timings exclude browser debounce, retries, persistence and restoration;
synthetic provider costs are not Production forecasts.

## Focused checks

```sh
node --import tsx --test scripts/benchmarks/suggestions/benchmark.test.mts
PYTHONDONTWRITEBYTECODE=1 python3 scripts/benchmarks/suggestions/test_analyze_progress.py
```

The existing independent 50/50 test remains the source for causal return-use and
exploratory customer-spending evidence. Its original assignments, enrollment dates,
primary metrics and grandfathered access are not changed by this benchmark. A
released prompt is a treatment epoch, not a reason to restart or reassign users.
