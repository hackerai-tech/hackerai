// Bounded synthetic evaluation. No customer conversations or notes are read.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateText, Output } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";
import {
  buildPredictionSources,
  generatedNextActionsSchema,
  validateGroundedSuggestions,
} from "@/lib/chat/next-actions/contracts";
import { generateNextActions } from "@/lib/chat/next-actions/generate";

const fixturePath = resolve(__dirname, "fixtures.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  baselinePrompt: string;
  cases: {
    id: string;
    user: string;
    assistant: string;
    language: string;
    kind: string;
    messages?: {
      id: string;
      role: "user" | "assistant";
      parts: { type: string; text: string }[];
    }[];
  }[];
};
const args = process.argv.slice(2);
const selectedCount = Number(
  args.find((arg) => arg.startsWith("--cases="))?.split("=")[1] ??
    fixture.cases.length,
);
if (
  !Number.isInteger(selectedCount) ||
  selectedCount < 1 ||
  selectedCount > fixture.cases.length
)
  throw new Error("Invalid bounded case count");
const cases = fixture.cases.slice(0, selectedCount);
const plan = {
  synthetic: true,
  batches: cases.length * 2,
  maximumProviderCalls: cases.length * 3,
  fixtureHash: createHash("sha256")
    .update(readFileSync(fixturePath))
    .digest("hex"),
};

async function main() {
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ ...plan, live: false }));
    return;
  }
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error(
      "Development OpenRouter key required; load the approved Development environment",
    );
  const outputArg = args
    .find((arg) => arg.startsWith("--output="))
    ?.slice("--output=".length);
  if (!outputArg)
    throw new Error("Live evaluation requires a private --output path");
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const report = {
    ...plan,
    started: new Date().toISOString(),
    rows: [] as Record<string, unknown>[],
  };
  for (const [index, item] of cases.entries()) {
    const id = (key: string) =>
      createHash("sha256")
        .update(`${item.id}:${key}`)
        .digest("hex")
        .slice(0, 32);
    const messages = item.messages?.map((m) => ({ ...m, id: id(m.id) })) ?? [
      {
        id: id("a"),
        role: "assistant" as const,
        parts: [{ type: "text", text: item.assistant }],
      },
      {
        id: id("u"),
        role: "user" as const,
        parts: [{ type: "text", text: item.user }],
      },
    ];
    const sources = buildPredictionSources(messages);
    for (const variant of index % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const started = performance.now();
      const signal = AbortSignal.timeout(8_000);
      let row: Record<string, unknown>;
      if (variant === "candidate") {
        const result = await generateNextActions(sources, signal);
        row = {
          ...result,
          case: item.id,
          variant,
          ms: Math.round(performance.now() - started),
        };
      } else {
        try {
          const result = await generateText({
            model: myProvider.languageModel(DEEPSEEK_1017_MODEL_KEY),
            system: fixture.baselinePrompt,
            prompt: JSON.stringify(sources),
            providerOptions: {
              openrouter: {
                reasoning: { enabled: false },
                provider: { require_parameters: true, sort: "throughput" },
              },
            },
            output: Output.object({ schema: generatedNextActionsSchema }),
            temperature: 0,
            maxOutputTokens: 700,
            maxRetries: 0,
            timeout: 8_000,
            abortSignal: signal,
          });
          const cost = getProviderUsageRawModelCost(result.usage.raw);
          row = {
            case: item.id,
            variant,
            suggestions: validateGroundedSuggestions(result.output, sources),
            ms: Math.round(performance.now() - started),
            providerCalls: 1,
            pricedProviderCalls: cost === undefined ? 0 : 1,
            unknownProviderCalls: cost === undefined ? 1 : 0,
            knownCost: cost ?? 0,
            cost,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            modelId: result.response.modelId,
            reasoningTokens: result.usage.outputTokenDetails.reasoningTokens,
            unavailable: false,
          };
        } catch {
          row = {
            case: item.id,
            variant,
            suggestions: [],
            ms: Math.round(performance.now() - started),
            providerCalls: 1,
            pricedProviderCalls: 0,
            unknownProviderCalls: 1,
            unavailable: true,
          };
        }
      }
      report.rows.push(row);
      writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    console.log(
      JSON.stringify({
        completedCases: index + 1,
        batches: report.rows.length,
        providerCalls: report.rows.reduce(
          (sum, row) => sum + Number(row.providerCalls),
          0,
        ),
      }),
    );
  }
}
main().catch(() => {
  console.error(
    "Synthetic evaluation failed; inspect setup without printing credentials or provider payloads.",
  );
  process.exitCode = 1;
});
