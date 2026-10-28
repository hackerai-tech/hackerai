# RealVuln source-review evaluation

This is a separate public vulnerability-discovery lane alongside CVE-Bench. It
uses the shared HackerAI Pro Agent runner, terminal/file/task tools, context
accounting, eligible one-turn continuation and safe provider recovery. Agent
commands and file operations run in an offline Docker container containing
only the target's pinned source. The RealVuln ground truth and OpenRouter key
remain on the host. Account-backed reporting, browser and Desktop transports
are unavailable in this adapter; this is not a production deployment test.

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

Use an isolated worktree with its own `node_modules` and the approved local
Development configuration. Keep raw results under ignored `.artifacts/`.

```sh
corepack pnpm install --frozen-lockfile
git clone https://github.com/kolega-ai/Real-Vuln-Benchmark.git .artifacts/realvuln/upstream
git -C .artifacts/realvuln/upstream checkout --detach 7a710251f55c17d32d3adcb13d37468e2e3b9e4a
python3 scripts/benchmarks/realvuln/run.py \
  --agent-model-context-variant test \
  --agent-limit-seconds 480
```

Check the eligible Pro Agent context flag in the actual environment before
choosing `test` or `control`. By default the runner audits four small,
human-authored Python and JavaScript projects. Pass explicit RealVuln slugs to
select other human-authored projects. `--max-samples` controls concurrency
(1–4); `--agent-limit-seconds` accepts 60–21600. The runner defaults to the
dedicated `cvebench-amd64` Colima Docker socket; set `--docker-host` or
`REALVULN_DOCKER_HOST` to an explicit isolated daemon. Start that daemon
separately, and do not stop it while another evaluation uses it.

The Agent sees only a generic source-review instruction and the pinned target
checkout at `/app`. It writes a bounded JSON array to `/output/findings.json`:
each item has repository-relative `path`, one-based `line`, one `cwe`,
`severity`, and concise `evidence`. `[]` is an explicit no-finding result.
The adapter converts valid items to Semgrep-compatible JSON and calls the
pinned RealVuln parser, matcher and scorer. Duplicate reports remain separate
so RealVuln can penalize them. Missing or malformed Agent output is recorded as
a protocol failure and scored with zero findings; failures before Agent startup
are unscored. The summary reports per-project TP, FP, FN, F2, F3, cost, runtime,
stop reason and continuation count. Aggregate micro-F2 is derived only from
scored cases, and the scored/unscored denominator is always shown.

The manifest pins HackerAI and RealVuln revisions, target commits, ground-truth
hash, Docker image, Pro context variant and run limits. Model output, reports
and target logs stay in ignored local artifacts; do not publish them to a PR.
For a fair comparison, keep the target set, prompt, model route, context flag,
limits, and scorer revision fixed between runs. Public labels may be known to
models, so corroborate trends on newly selected targets before attributing a
change to HackerAI.
