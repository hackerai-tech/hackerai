/** Offline by default. No app API, analytics, DB, billing or flag imports. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
  messages: Parameters<typeof buildPredictionSources>[0];
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
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
export function fixtures(): Fixture[] {
  return JSON.parse(readFileSync(resolve(directory, "fixtures.json"), "utf8"));
}
export function prepare(split: "tuning" | "holdout") {
  const cases = fixtures().filter((f) => f.split === split);
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
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export function reportedCost(raw: unknown): number | null {
  const positive = getProviderUsageRawModelCost(raw);
  if (positive !== undefined) return positive;
  // An explicitly reported free request is priced; missing USD is not zero.
  return raw && typeof raw === "object" && "cost" in raw && raw.cost === 0
    ? 0
    : null;
}
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

async function main() {
  const [command, destination, split = "tuning"] = process.argv.slice(2);
  if (!destination || !["tuning", "holdout"].includes(split))
    throw new Error("Use prepare|run|review OUT_DIR [tuning|holdout]");
  const out = resolve(destination);
  if (out === directory || out.startsWith(root + "/"))
    throw new Error("Keep generated results outside the repository");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  if (command === "prepare") {
    const plan = prepare(split as "tuning" | "holdout");
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
      throw new Error(
        "Supply a Development OPENROUTER_API_KEY and SUGGESTION_BENCH_LIVE=development explicitly",
      );
    const { generateText, Output } = await import("ai");
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const { predictedNextActionSchema } =
      await import("../../../lib/chat/next-actions/contracts");
    const plan = JSON.parse(
      readFileSync(resolve(out, "plan.json"), "utf8"),
    ) as ReturnType<typeof prepare>;
    if (JSON.stringify(plan) !== JSON.stringify(prepare(plan.manifest.split)))
      throw new Error("Source or plan drift; prepare a fresh run");
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
          receipt.costUsd = reportedCost(result.usage.raw);
          receipt.output = result.output;
          receipt.inputTokens = result.usage.inputTokens ?? null;
          receipt.outputTokens = result.usage.outputTokens ?? null;
          receipt.reasoningTokens =
            result.usage.outputTokenDetails.reasoningTokens ?? null;
          receipt.model = result.response.modelId ?? null;
        }
      } catch {
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
    if (JSON.stringify(plan) !== JSON.stringify(prepare(plan.manifest.split)))
      throw new Error("Source or review rubric drift; use the pinned checkout");
    const receipts = readFileSync(resolve(out, "receipts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s) as Receipt);
    summarize(receipts); // Validates duplicates and financial fields before review export.
    const byId = new Map(plan.rows.map((r) => [r.id, r]));
    const cases = new Map(fixtures().map((f) => [f.id, f]));
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
          suggestion: parsePredictedNextAction(r.output)[0] ?? null,
          unavailable: r.unavailable,
          usefulness: null,
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
  } else throw new Error("Unknown command");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Benchmark failed. Check inputs and receipts privately; no credentials or provider payload logged.",
    );
    process.exitCode = 1;
  });
