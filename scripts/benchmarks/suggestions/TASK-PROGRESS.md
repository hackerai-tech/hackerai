# Usefulness and task-progress comparison

This historical protocol evaluated task progress rather than latency. The current
next-input prediction objective is described in [PREDICTION.md](PREDICTION.md). The earlier
regression benchmark and its recorded result remain historical evidence; they are
not regraded under these criteria. Latency and company cost are operational checks,
not winning metrics. This isolated evaluation does not alter the live retention
experiment, its primary outcome, dates or first assignment.

## Before generating outputs

Use the `task-progress` suite: 48 fresh conversations, with 24 tuning and 24 reserved
test cases. Forty require a useful continuation; eight cover completed tasks or
explicit stops. Each arm gets two interleaved repeats per case. Both use the same
DeepSeek snapshot, context builder, parser, routing and generation settings.

Cases cover missing observations/files, direct choices, verification after a fix,
learning, scope, requested reports, failed tools, already-delivered question replies,
completed work and multi-turn constraints. Goal/rubric annotations go only to
reviewers, never the generator. All conversations are synthetic. User-provided
production examples are not fixtures.

Primary: mean **task progress**, 0–3, on continuation-required cases, retaining
unavailable and empty results as zero. A useful next input must help the assistant
advance the original task or remove its next blocker. Do not reward extra messages,
generic acknowledgments, repeated answers or unnecessary repackaging.

Secondary: usefulness, 0–3, covering relevance, user voice and practicality; useful
nonempty coverage on continuation cases; appropriate silence on completed tasks.
Explicit-stop prechecks remain separate from model-selected silence.

Scoring anchors:

- 0: cannot advance the task, contradicts evidence, fabricates observed facts,
  reverses speaker roles, or gives no input when a useful step is clearly needed.
- 1: related but vague, repetitive, or leaves the actual blocker unresolved.
- 2: a concrete useful next step or direct answer that advances the task.
- 3: a natural, specific next input that directly removes the main blocker or
  advances the requested work with the needed constraints.

A justified null on completed work scores 3 for the secondary usefulness/silence
guardrail, but is not included in primary task-progress averages. Direct choices
and generic confirmations are permitted editable drafts. Invented exact observations,
supplied files, credentials, environments, permission documents or approved hosts
are separate factual-failure flags. A draft never grants authorization.

Use two independent model reviewers with shuffled anonymous outputs, no generating
arm, costs or timings. Verify exact output-ID coverage. Report each reviewer's scores
and disagreements; adjudicate factual disagreements against the actual context.
These are model evaluations, not human ratings or observed customer benefit.

Allow up to three tuning revisions. Freeze the selected candidate before generating
the reserved test set; do not revise it after viewing those outputs. Acceptance
requires a primary improvement of at least 0.25 points and a paired scenario-cluster
bootstrap 95% lower bound above zero, no confirmed serious factual/tool-trust/stop
failure in reserved outputs, no more than a 5pp drop in useful continuation coverage,
and no more than a 5pp increase in unwanted completed-task follow-ups. Report
uncertainty and both reviewers. An undersized or incomplete result is inconclusive,
not permission to loosen the criteria. No latency or price improvement is required.

## Run and record

```sh
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts prepare /private/tmp/task-progress-tuning tuning task-progress
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts run /private/tmp/task-progress-tuning
corepack pnpm exec tsx scripts/benchmarks/suggestions/benchmark.ts review /private/tmp/task-progress-tuning
```

Use a fresh directory and the explicit approved Development key/opt-in described in
README.md. Keep manifests, outputs, reviews and receipts private outside the checkout.
Generation keeps the existing $0.50 known-spend stop and stops on unknown pricing.
Each independent evaluator has a $3 known-spend watch limit; one in-flight call may
cross it. Missing costs remain unknown. Do not charge customers for evaluation.

Even a successful offline result establishes only a synthetic quality improvement.
Actual completion and return-use benefit remain questions for the unchanged 50/50
experiment. A prompt release is an evolving-treatment epoch, not a new allocation
or a reason to restart enrollment or remove inconvenient users.
