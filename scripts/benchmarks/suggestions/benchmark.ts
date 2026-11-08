/** Offline by default. No app API, analytics, DB, billing or flag imports. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  buildPredictionSources,
  hasExplicitPredictionStop,
  parsePredictedNextAction,
} from "../../../lib/chat/next-actions/contracts";
import { DEEPSEEK_1017_SLUG } from "../../../lib/experiments/paid-deepseek-1017";
import { getProviderUsageRawModelCost } from "../../../lib/provider-usage-cost";

const directory = dirname(fileURLToPath(import.meta.url));
export const root = resolve(directory, "../../..");
export type Fixture = {
  id: string;
  split: "tuning" | "holdout";
  category: string;
  expectation: "suggest" | "silence" | "either";
  rubric: string;
  goal?: string;
  progressCriteria?: string[];
  messages: Parameters<typeof buildPredictionSources>[0];
};
/** Pin source/configuration fingerprints in each run manifest. */
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Only static messages written by this runner may reach the terminal.
class BenchmarkUsageError extends Error {}

/** Explain known local setup failures without echoing arbitrary SDK or IO errors. */
export function benchmarkFailureMessage(error: unknown): string {
  return error instanceof BenchmarkUsageError
    ? error.message
    : "Benchmark failed. Check inputs and receipts privately; no credentials or provider payload logged.";
}

/** Detect containment using path segments, including Windows drives and separators. */
export function withinRepository(
  repository: string,
  destination: string,
  paths = { relative, isAbsolute, sep },
) {
  const path = paths.relative(repository, destination);
  return (
    path === "" ||
    !(
      path === ".." ||
      path.startsWith(".." + paths.sep) ||
      paths.isAbsolute(path)
    )
  );
}
/** Keep result files outside the checkout, including through directory symlinks. */
export function benchmarkDestination(destination: string) {
  const out = resolve(destination);
  if (withinRepository(root, out))
    throw new BenchmarkUsageError(
      "Keep generated results outside the repository",
    );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const actual = realpathSync(out),
    repository = realpathSync(root);
  if (withinRepository(repository, actual))
    throw new BenchmarkUsageError(
      "A result-directory symlink points into the repository",
    );
  return actual;
}
export const settings = {
  model: DEEPSEEK_1017_SLUG,
  temperature: 0,
  maxOutputTokens: 160,
  maxRetries: 0,
  timeout: 8000,
  providerOptions: {
    openrouter: {
      reasoning: { enabled: false },
      provider: { require_parameters: true, sort: "throughput" },
    },
  },
};

/** Parse a literal with the TS parser, never eval/import application providers. */
export function baselineSystem() {
  const file = ts.createSourceFile(
    "generate.ts",
    readFileSync(resolve(root, "lib/chat/next-actions/generate.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let system: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "SYSTEM" &&
      node.initializer &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isStringLiteral(node.initializer))
    )
      system = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!system)
    throw new Error(
      "Baseline SYSTEM must be a single literal; update the adapter explicitly.",
    );
  return system;
}
/** Load committed synthetic cases without consulting application/chat services. */
export type BenchmarkSuite = "regression" | "task-progress";
export function fixtures(suite: BenchmarkSuite = "regression"): Fixture[] {
  return JSON.parse(
    readFileSync(
      resolve(
        directory,
        suite === "task-progress"
          ? "task-progress-fixtures.json"
          : "fixtures.json",
      ),
      "utf8",
    ),
  );
}
/** Freeze a paired, balanced request schedule before observing provider results. */
export function prepare(
  split: "tuning" | "holdout",
  suite: BenchmarkSuite = "regression",
) {
  const cases = fixtures(suite).filter((f) => f.split === split);
  if (!cases.length || new Set(cases.map((f) => f.id)).size !== cases.length)
    throw new Error("Missing cases or duplicate IDs");
  const systems = [
    baselineSystem(),
    readFileSync(resolve(directory, "candidate.txt"), "utf8").trim(),
  ];
  const rows = [];
  for (const [i, fixture] of cases.entries()) {
    if (!fixture.messages.length || !fixture.rubric)
      throw new Error("Incomplete fixture");
    const sources = buildPredictionSources(fixture.messages);
    if (!sources.length) throw new Error("Empty built context");
    // Balanced AB/BA pairs; both repeats stay in the same scenario cluster.
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const arm of (i + repeat) % 2 ? [1, 0] : [0, 1]) {
        rows.push({
          id: `${fixture.id}-${repeat}-${arm}`,
          caseId: fixture.id,
          repeat,
          arm,
          split,
          skip: hasExplicitPredictionStop(sources),
          system: systems[arm],
          prompt: JSON.stringify(
            sources.map(({ role, text }) => ({ role, text })),
          ),
          settings,
        });
      }
    }
  }
  return {
    manifest: {
      baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      suite,
      split,
      caseCount: cases.length,
      plannedBatches: rows.length,
      plannedProviderCalls: rows.filter((r) => !r.skip).length,
      fixtureHash: digest(JSON.stringify(cases)),
      systemHashes: systems.map(digest),
      contextHash: digest(
        readFileSync(
          resolve(root, "lib/chat/next-actions/contracts.ts"),
          "utf8",
        ),
      ),
      toolContextHash: digest(
        readFileSync(
          resolve(root, "lib/chat/next-actions/tool-context.ts"),
          "utf8",
        ),
      ),
      generatorHash: digest(
        readFileSync(
          resolve(root, "lib/chat/next-actions/generate.ts"),
          "utf8",
        ),
      ),
      settings,
    },
    rows,
  };
}

export type Receipt = {
  id: string;
  providerCalls: number;
  costUsd: number | null;
  latencyMs: number;
  output: unknown;
  unavailable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  model: string | null;
};
/** Reject non-finite or negative financial and timing measurements. */
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
/** Preserve explicitly reported free calls without pricing missing USD as zero. */
export function reportedCost(raw: unknown): number | null {
  const positive = getProviderUsageRawModelCost(raw);
  if (positive !== undefined) return positive;
  // An explicitly reported free request is priced; missing USD is not zero.
  return raw && typeof raw === "object" && "cost" in raw && raw.cost === 0
    ? 0
    : null;
}
/** Keep valid price/token receipts even when structured-output parsing fails. */
export function retainProviderReceipt(
  receipt: Receipt,
  usage:
    | {
        raw?: unknown;
        inputTokens?: number;
        outputTokens?: number;
        outputTokenDetails?: { reasoningTokens?: number };
      }
    | undefined,
  response: { modelId?: string } | undefined,
) {
  const tokens = (value: unknown) =>
    finite(value) && Number.isInteger(value) ? value : null;
  receipt.costUsd = reportedCost(usage?.raw);
  receipt.inputTokens = tokens(usage?.inputTokens);
  receipt.outputTokens = tokens(usage?.outputTokens);
  receipt.reasoningTokens = tokens(usage?.outputTokenDetails?.reasoningTokens);
  receipt.model =
    typeof response?.modelId === "string" ? response.modelId : null;
}
/** Fail closed on contradictory call counts, USD and token metadata. */
export function validateReceipt(r: Receipt) {
  if (
    !r ||
    typeof r.id !== "string" ||
    ![0, 1].includes(r.providerCalls) ||
    !finite(r.latencyMs) ||
    (r.costUsd !== null && !finite(r.costUsd)) ||
    typeof r.unavailable !== "boolean" ||
    [r.inputTokens, r.outputTokens, r.reasoningTokens].some(
      (v) => v !== null && (!finite(v) || !Number.isInteger(v)),
    ) ||
    (r.model !== null && typeof r.model !== "string") ||
    (r.providerCalls === 0 &&
      (r.costUsd !== 0 ||
        [r.inputTokens, r.outputTokens, r.reasoningTokens].some(
          (v) => v !== null,
        )))
  )
    throw new Error("Invalid or contradictory receipt");
}
/** Report attempts, known spend and receipt coverage without inventing quality scores. */
export function summarize(rows: Receipt[]) {
  rows.forEach(validateReceipt);
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("Duplicate receipt IDs");
  const priced = rows.filter((r) => r.providerCalls && r.costUsd !== null);
  const calls = rows.reduce((s, r) => s + r.providerCalls, 0);
  const latencies = rows
    .filter((r) => r.providerCalls)
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  const known = priced.reduce((s, r) => s + r.costUsd!, 0);
  const tokenTotals = (
    field: "inputTokens" | "outputTokens" | "reasoningTokens",
  ) => {
    const covered = rows.filter((r) => r.providerCalls && r[field] !== null);
    return {
      coveredCalls: covered.length,
      tokens: covered.length
        ? covered.reduce((s, r) => s + r[field]!, 0)
        : null,
    };
  };
  return {
    batches: rows.length,
    calls,
    pricedCalls: priced.length,
    unknownCalls: calls - priced.length,
    knownCostUsd: known,
    costPer1000PricedCalls: priced.length
      ? (known / priced.length) * 1000
      : null,
    knownCostPerBatch: rows.length ? known / rows.length : null,
    input: tokenTotals("inputTokens"),
    output: tokenTotals("outputTokens"),
    reasoning: tokenTotals("reasoningTokens"),
    models: Object.fromEntries(
      [
        ...new Set(
          rows.filter((r) => r.providerCalls && r.model).map((r) => r.model!),
        ),
      ].map((model) => [
        model,
        rows.filter((r) => r.providerCalls && r.model === model).length,
      ]),
    ),
    unknownModelCalls: rows.filter((r) => r.providerCalls && r.model === null)
      .length,
    medianProviderPathMs: latencies.length
      ? latencies[Math.ceil(latencies.length * 0.5) - 1]
      : null,
    p95ProviderPathMs: latencies.length
      ? latencies[Math.ceil(latencies.length * 0.95) - 1]
      : null,
    unavailable: rows.filter((r) => r.unavailable).length,
    usableFormat: rows.filter(
      (r) => !r.unavailable && parsePredictedNextAction(r.output).length === 1,
    ).length,
    quality:
      "UNREVIEWED: valid format is not usefulness, safety, or retention evidence",
  };
}

/** Run the explicitly selected workflow without loading application services. */
async function main() {
  const [command, destination, split = "tuning", suite = "regression"] =
    process.argv.slice(2);
  if (
    !destination ||
    !["tuning", "holdout"].includes(split) ||
    !["regression", "task-progress"].includes(suite)
  )
    throw new BenchmarkUsageError(
      "Use prepare|run|review OUT_DIR [tuning|holdout] [regression|task-progress]",
    );
  const out = benchmarkDestination(destination);
  if (command === "prepare") {
    const plan = prepare(
      split as "tuning" | "holdout",
      suite as BenchmarkSuite,
    );
    writeFileSync(resolve(out, "plan.json"), JSON.stringify(plan, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(plan.manifest, null, 2));
  } else if (command === "run") {
    // Deliberate Development provider opt-in. No dotenv, application services or telemetry.
    if (
      process.env.SUGGESTION_BENCH_LIVE !== "development" ||
      !process.env.OPENROUTER_API_KEY
    )
      throw new BenchmarkUsageError(
        "Supply a Development OPENROUTER_API_KEY and SUGGESTION_BENCH_LIVE=development explicitly",
      );
    const { generateText, Output, NoObjectGeneratedError } = await import("ai");
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const { predictedNextActionSchema } =
      await import("../../../lib/chat/next-actions/contracts");
    const plan = JSON.parse(
      readFileSync(resolve(out, "plan.json"), "utf8"),
    ) as ReturnType<typeof prepare>;
    if (
      JSON.stringify(plan) !==
      JSON.stringify(prepare(plan.manifest.split, plan.manifest.suite))
    )
      throw new BenchmarkUsageError(
        "Source or plan drift; prepare a fresh run",
      );
    const provider = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    const receipts: Receipt[] = [];
    const output = resolve(out, "receipts.jsonl");
    writeFileSync(output, "", { flag: "wx", mode: 0o600 });
    for (const row of plan.rows) {
      const start = performance.now();
      const receipt: Receipt = {
        id: row.id,
        providerCalls: row.skip ? 0 : 1,
        costUsd: row.skip ? 0 : null,
        latencyMs: 0,
        output: { suggestion: null },
        unavailable: false,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        model: null,
      };
      try {
        if (!row.skip) {
          const result = await generateText({
            ...settings,
            model: provider(settings.model),
            system: row.system,
            prompt: row.prompt,
            output: Output.object({ schema: predictedNextActionSchema }),
            abortSignal: AbortSignal.timeout(settings.timeout),
          });
          retainProviderReceipt(receipt, result.usage, result.response);
          receipt.output = result.output;
        }
      } catch (error) {
        // Structured-output failure can still carry a billed provider receipt.
        if (NoObjectGeneratedError.isInstance(error))
          retainProviderReceipt(receipt, error.usage, error.response);
        receipt.unavailable = true;
      }
      receipt.latencyMs = performance.now() - start;
      validateReceipt(receipt);
      receipts.push(receipt);
      const { appendFileSync } = await import("node:fs");
      appendFileSync(output, JSON.stringify(receipt) + "\n");
      // Stop on unknown costs or $0.50 known spend. One in-flight call may cross the cap.
      if (
        (receipt.providerCalls && receipt.costUsd === null) ||
        receipts.reduce((s, r) => s + (r.costUsd ?? 0), 0) >= 0.5
      )
        break;
    }
    console.log(JSON.stringify(summarize(receipts), null, 2));
  } else if (command === "review") {
    const plan = JSON.parse(
      readFileSync(resolve(out, "plan.json"), "utf8"),
    ) as ReturnType<typeof prepare>;
    if (
      JSON.stringify(plan) !==
      JSON.stringify(prepare(plan.manifest.split, plan.manifest.suite))
    )
      throw new BenchmarkUsageError(
        "Source or review rubric drift; use the pinned checkout",
      );
    const receipts = readFileSync(resolve(out, "receipts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s) as Receipt);
    summarize(receipts); // Validates duplicates and financial fields before review export.
    const byId = new Map(plan.rows.map((r) => [r.id, r]));
    const cases = new Map(fixtures(plan.manifest.suite).map((f) => [f.id, f]));
    const blind = receipts
      .map((r) => {
        const request = byId.get(r.id);
        if (!request || r.providerCalls !== Number(!request.skip))
          throw new Error("Receipt not in pinned plan");
        const fixture = cases.get(request.caseId)!;
        return {
          reviewId: digest(plan.manifest.fixtureHash + r.id).slice(0, 20),
          context: JSON.parse(request.prompt),
          expectation: fixture.expectation,
          rubric: fixture.rubric,
          ...(fixture.goal && { goal: fixture.goal }),
          ...(fixture.progressCriteria && {
            progressCriteria: fixture.progressCriteria,
          }),
          suggestion: parsePredictedNextAction(r.output)[0] ?? null,
          unavailable: r.unavailable,
          usefulness: null,
          taskProgress: null,
          inventedEvidence: null,
          inventedSpecificAuthorization: null,
          ignoresStop: null,
          falseToolClaim: null,
          comments: "",
        };
      })
      .sort((a, b) => a.reviewId.localeCompare(b.reviewId));
    writeFileSync(
      resolve(out, "blind-review.json"),
      JSON.stringify(blind, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      resolve(out, "summary.json"),
      JSON.stringify(
        {
          complete: receipts.length === plan.rows.length,
          arms: [0, 1].map((arm) => ({
            arm,
            ...summarize(receipts.filter((r) => byId.get(r.id)?.arm === arm)),
          })),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Wrote blinded review and operational summaries; no quality winner has been evaluated.",
    );
  } else throw new BenchmarkUsageError("Unknown command");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    console.error(benchmarkFailureMessage(error));
    process.exitCode = 1;
  });
