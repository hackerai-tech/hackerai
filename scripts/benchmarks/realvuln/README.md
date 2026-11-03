# RealVuln source-review evaluation

The default RealVuln runner submits an authenticated Preview Pro Agent request
to `/api/agent`. The normal Trigger worker constructs the prompt, tools,
skills, delegation, provider route, persistence, and continuation behavior.
The benchmark driver supplies only the pinned target objective and passes the
saved Agent answer to the official scorer. It does not copy the Agent loop.
This product-backend protocol differs from the older offline Docker adapter;
keep their scores and cost/latency comparisons separate.

The older isolated adapter remains available only with `--isolated-adapter`.
It offers terminal/file/task tools and cannot measure account-backed reports,
skills, delegation, browser, or native transport. Its Docker container uses
`--init` to reap detached command workers.

The upstream [RealVuln](https://github.com/kolega-ai/Real-Vuln-Benchmark)
dataset, matcher and scorer are pinned to commit
`7a710251f55c17d32d3adcb13d37468e2e3b9e4a` (benchmark 3.1.0). Its
primary metric is F3; this lane also reports RealVuln's native F2. Neither
metric is DeepsecBench-AA F2. RealVuln's current targets are intentionally
vulnerable applications with public labels. Treat this as a repeatable internal
regression measure, not a held-out capability estimate.

At this pinned upstream commit, `compute_gt_hash.py` produces a different
ground-truth hash from the value recorded in upstream `benchmark-manifest.json`.
This adapter verifies the actual checkout's hash and records both values in
its manifest; it does not treat the stale published value as evidence of file
integrity.

## Setup and run

Use an isolated worktree with its own dependencies and approved Development
configuration. Keep raw results outside Git. Supply a protected JSON record
through standard input with `workosSealedSession` for the existing Preview Pro
QA account and, when Preview is Vercel protected, a short-lived
`vercelOidcToken`. Never put either credential in an argument or log. Confirm
the exact Vercel Preview and Trigger deployment identities before the run. One account has one cloud workspace, so
this driver runs targets sequentially. The target is cloned at its pinned
commit by the real Agent; the host independently fetches the same revision to
validate report paths and score with the pinned upstream.

```sh
python3 scripts/benchmarks/realvuln/run.py \
  --base-url https://YOUR-PREVIEW.vercel.app \
  --upstream /private/pinned/realvuln/upstream \
  --results-dir /private/unique-results-dir < /private/credentials-json-stdin
```

By default the product-backend runner audits four human-authored projects.
Pass explicit slugs to select a subset. It requires the Preview Pro QA account
and healthy Preview Trigger worker. `--agent-limit-seconds` bounds each Agent
run. The driver records each chat and Trigger run ID before waiting; it never
relaunches into an existing results directory. Missing live-stream evidence,
malformed output, or a backend failure stays unscored. Do not automatically
retry those cases.

For a separate offline diagnostic, use `--isolated-adapter` with the previous
`--agent-model-context-variant`, `--docker-host`, and concurrency options. Label
its results as isolated-adapter, never product-backend parity.

The Agent receives a generic source-review instruction and the pinned target
repository URL and commit. It returns a bounded JSON array:
each item has repository-relative `path`, one-based `line`, one `cwe`,
`severity`, and concise `evidence`. `[]` is an explicit no-finding result.
The driver converts valid items to Semgrep-compatible JSON and calls the
pinned RealVuln parser, matcher and scorer. Duplicate reports remain separate
so RealVuln can penalize them. Missing or malformed Agent output is a protocol
failure and remains unscored; an explicit `[]` is a scored report with zero
findings. Backend or stream failures are also unscored. The summary reports
per-project TP, FP, FN, F2, F3, wall time, and continuation count. The
authenticated user API does not expose model cost or aggregate Agent runtime,
so those fields remain unavailable rather than estimated. Aggregate micro-F2
is derived only from scored cases, with the scored/unscored denominator shown.

The manifest pins the RealVuln revision, target commits, ground-truth hash,
Preview origin, model selection and run limits. Record exact web and Trigger
deployment identities in the private readout. The saved answer is available in
the QA account as well as the private scorer input. Delete only task-owned chats
and workspace files after reading results; do not remove an unrelated QA
workspace. A source-only instruction does not make a networked product sandbox
equivalent to offline Docker. Report that protocol difference and any external
tool use. Public labels may be known to models, so corroborate trends on new
targets before attributing a change to HackerAI.
