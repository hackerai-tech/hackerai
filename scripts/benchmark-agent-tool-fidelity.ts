import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateText, type ToolSet } from "ai";
import {
  scoreToolFidelity,
  toolFidelityFixtures,
} from "./fixtures/tool-fidelity";

// NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/benchmark-agent-tool-fidelity.ts [--live] [--provider=slug] [--model=glm]
// Uses only this checkout's approved Development credentials. No tools execute,
// no customer histories are read, and no feature flags are evaluated or changed.
class UsageError extends Error {}

/** Runs synthetic model checks only with explicit live opt-in; tools never execute. */
async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        arg !== "--live" &&
        arg !== "--model=glm" &&
        !/^--provider=[a-z0-9/-]+$/.test(arg),
    )
  )
    throw new UsageError(
      "Unsupported argument. Use --live, --provider=slug, or --model=glm.",
    );
  const provider = args
    .find((arg) => arg.startsWith("--provider="))
    ?.slice("--provider=".length);
  const nonce = randomBytes(8).toString("hex");
  const fixtures = toolFidelityFixtures(nonce);
  if (!args.includes("--live")) {
    console.log(
      JSON.stringify({
        live: false,
        cases: fixtures.map(({ id, modes }) => ({ id, modes })),
        calls: fixtures.reduce(
          (sum, fixture) => sum + fixture.modes.length * 2,
          0,
        ),
        provider: provider ?? "application routing",
        model: args.includes("--model=glm") ? "glm" : "deepseek",
        note: "Use --live for paid provider calls. Dry run is not model-quality evidence.",
      }),
    );
    return;
  }
  config({ path: ".env.local", quiet: true, override: true });
  if (!process.env.OPENROUTER_API_KEY)
    throw new UsageError(
      "Missing Development provider configuration in .env.local.",
    );
  const { myProvider } = await import("../lib/ai/providers");
  const { DEEPSEEK_1017_MODEL_KEY } =
    await import("../lib/experiments/paid-deepseek-1017");
  const { buildProviderOptions } =
    await import("../lib/api/chat-stream-helpers");
  const { systemPrompt } = await import("../lib/system-prompt");
  const schemas = await import("../lib/ai/tools/schemas");
  const modelKey = args.includes("--model=glm")
    ? "model-glm-5.3-flash"
    : DEEPSEEK_1017_MODEL_KEY;
  const model = myProvider.languageModel(modelKey);
  const outputDir = `.artifacts/tool-fidelity/${new Date().toISOString().replace(/[:.]/g, "-")}-${nonce}`;
  mkdirSync(outputDir, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  const report = {
    scope:
      "One-generation synthetic continuation with application prompt, schemas and provider options. No sandbox execution, full Agent loop, compaction, customer recovery or rollout acceptance.",
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceSha256: createHash("sha256")
      .update(readFileSync("scripts/benchmark-agent-tool-fidelity.ts"))
      .update(readFileSync("scripts/fixtures/tool-fidelity.ts"))
      .digest("hex"),
    nonce,
    fixtures,
    rows,
  };
  let failures = 0;
  for (const [index, fixture] of fixtures.entries()) {
    // Both tiers see identical fresh fixtures. Alternate order to reduce time/cache bias.
    const tiers =
      index % 2
        ? (["hackerai-pro", "hackerai-standard"] as const)
        : (["hackerai-standard", "hackerai-pro"] as const);
    for (const mode of fixture.modes)
      for (const tier of tiers) {
        const system = await systemPrompt(
          "synthetic-tool-fidelity",
          mode,
          "pro",
          modelKey,
          null,
          null,
          "ask_approval",
          true,
          undefined,
          tier,
        );
        const schemaSet = {
          ...schemas.createAgentToolSchemaSet({
            mode,
            hasJinaApiKey: true,
            hasPerplexityApiKey: true,
          }),
          ...(mode === "agent"
            ? {
                run_terminal_cmd: schemas.createRunTerminalCmdToolSchema({
                  modelName: modelKey,
                  approvalGated: true,
                }),
                interact_terminal_session:
                  schemas.createInteractTerminalSessionToolSchema({
                    modelName: modelKey,
                  }),
                file_write: schemas.createFileWriteToolSchema({
                  modelName: modelKey,
                  approvalGated: true,
                }),
              }
            : {}),
        };
        const tools: ToolSet = Object.fromEntries(
          Object.entries(schemaSet).filter((entry) => entry[1] !== undefined),
        );
        if (
          Object.values(tools).some((tool) => "execute" in tool && tool.execute)
        )
          throw Error("Benchmark must never execute tools");
        const applicationOptions = buildProviderOptions(
          true,
          undefined,
          modelKey,
          mode,
          { selectedModelOverride: tier, requestedModelSlug: model.modelId },
        );
        if (!("openrouter" in applicationOptions))
          throw Error("Expected OpenRouter policy");
        // A controlled provider run cannot silently become a cross-provider or
        // cross-model comparison. Keep the application's reasoning policy.
        const providerOptions = provider
          ? {
              openrouter: {
                ...applicationOptions.openrouter,
                models: [],
                provider: {
                  ...applicationOptions.openrouter.provider,
                  only: [provider],
                  allow_fallbacks: false,
                },
              },
            }
          : applicationOptions;
        const start = Date.now();
        const base = {
          fixture: fixture.id,
          mode,
          tier,
          requestedModel: model.modelId,
          providerOptions,
          systemSha256: createHash("sha256").update(system).digest("hex"),
        };
        try {
          const result = await generateText({
            model,
            system,
            messages: fixture.messages,
            tools,
            maxOutputTokens: 4096,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(90_000),
            providerOptions,
          });
          const pass = scoreToolFidelity(fixture.expected, result);
          if (!pass) failures++;
          rows.push({
            ...base,
            status: pass ? "pass" : "fail",
            elapsedMs: Date.now() - start,
            servedModel: result.response.modelId,
            upstreamProvider:
              result.providerMetadata?.openrouter?.provider ?? null,
            finishReason: result.finishReason,
            text: result.text,
            toolCalls: result.toolCalls.map(({ toolName, input }) => ({
              toolName,
              input,
            })),
            usage: result.usage,
          });
        } catch (error) {
          failures++;
          // Provider errors can contain request headers. Keep only the error class.
          rows.push({
            ...base,
            status: "error",
            elapsedMs: Date.now() - start,
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
        writeFileSync(
          `${outputDir}/results.json`,
          JSON.stringify(report, null, 2),
        );
        const row = rows.at(-1)!;
        console.log(
          JSON.stringify({
            fixture: fixture.id,
            mode,
            tier,
            status: row.status,
            elapsedMs: row.elapsedMs,
            servedModel: row.servedModel,
            upstreamProvider: row.upstreamProvider,
          }),
        );
      }
  }
  console.log(
    JSON.stringify({
      report: `${outputDir}/results.json`,
      total: rows.length,
      failures,
    }),
  );
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    error instanceof UsageError
      ? error.message
      : error instanceof Error
        ? error.name
        : "benchmark_failed",
  );
  process.exitCode = 1;
});
