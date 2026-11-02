/**
 * Synthetic, bounded provider-cache comparison. No customer data or app services.
 * pnpm benchmark:prompt-cache:live --scope subagent --pairs 2
 * Repeat with --pairs 2 for balanced baseline/treatment ordering (12 calls).
 * Affinity is best-effort: a small sample can be inconclusive. Never infer hits
 * from latency or missing usage. Reported provider cost includes output work.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, tool, type ModelMessage } from "ai";
import {
  buildPromptCacheOptions,
  addPromptCacheBreakpoints,
} from "../lib/ai/prompt-cache";
import { createOpenRouterCacheSessionId } from "../lib/ai/openrouter-cache-session";
import { isAbliterationModel } from "../lib/ai/abliteration";
import {
  getOpenRouterProviderRoutingForModel,
  DEEPSEEK_V4_FLASH_VISION_SLUG,
} from "../lib/ai/providers";

type Row = {
  pair: number;
  variant: "baseline" | "treatment";
  step: number;
  input: number | null;
  cached: number | null;
  written: number | null;
  output: number | null;
  cost: number | null;
  elapsedMs: number;
  valid: boolean;
  generationId?: string;
  servedModel?: string;
  servedProvider?: string;
  affinityHintSent?: boolean;
  explicitCacheBreakpoints?: number;
  error?: string;
};
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

export function summarizeCacheRows(rows: Row[]) {
  const covered = rows.filter((r) => r.input !== null && r.cached !== null);
  const input = covered.reduce((sum, r) => sum + r.input!, 0);
  const cached = covered.reduce((sum, r) => sum + r.cached!, 0);
  return {
    calls: rows.length,
    valid: rows.filter((r) => r.valid).length,
    cacheCoverage: covered.length,
    inputTokensWithCacheCoverage: input,
    cachedTokens: cached,
    writeCoverage: rows.filter((r) => r.written !== null).length,
    writtenTokens: rows.some((r) => r.written !== null)
      ? rows.reduce((sum, r) => sum + (r.written ?? 0), 0)
      : null,
    cacheReadRatio: input > 0 ? cached / input : null,
    costCoverage: rows.filter((r) => r.cost !== null).length,
    reportedCost: rows.some((r) => r.cost !== null)
      ? rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
      : null,
    elapsedMs: rows.reduce((sum, r) => sum + r.elapsedMs, 0),
  };
}

/** Reproduce pre-change affinity: parent DeepSeek had it; children did not. */
export function baselineCacheOptions(
  modelId: string,
  sessionId: string,
  scope: "agent" | "subagent",
): ReturnType<typeof buildPromptCacheOptions> {
  return scope === "agent" && modelId.startsWith("deepseek/deepseek-v4")
    ? { openrouter: { session_id: sessionId } }
    : {};
}

async function main() {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const modelId =
    modelIndex < 0 ? DEEPSEEK_V4_FLASH_VISION_SLUG : args[modelIndex + 1];
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex < 0 ? "agent" : args[scopeIndex + 1];
  const pairIndex = args.indexOf("--pairs");
  const pairs = pairIndex < 0 ? 1 : Number(args[pairIndex + 1]);
  if (
    !args.includes("--live") ||
    !modelId ||
    (scope !== "agent" && scope !== "subagent") ||
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    pairs > 2
  ) {
    throw new Error(
      "Use --live [--model provider/model] [--scope agent|subagent] [--pairs 1|2]",
    );
  }
  const direct = isAbliterationModel(modelId);
  const keyName = direct ? "ABLITERATION_API_KEY" : "OPENROUTER_API_KEY";
  // Load only the needed model key, never backend/service configuration.
  const apiKey =
    process.env[keyName] || parse(readFileSync(".env.local"))[keyName];
  if (!apiKey) throw new Error(`Missing ${keyName}`);
  const model = direct
    ? createOpenAICompatible({
        name: "abliteration",
        baseURL: "https://api.abliteration.ai/v1",
        apiKey,
      })(modelId)
    : createOpenRouter({ apiKey })(modelId);
  const runId = randomUUID();
  const outputPath = `.artifacts/prompt-cache/${runId}.json`;
  mkdirSync(".artifacts/prompt-cache", { recursive: true });
  const rows: Row[] = [];
  const deadline = AbortSignal.timeout(6 * 60_000);
  const tools = {
    report: tool({
      description: "Return the current synthetic marker exactly.",
      inputSchema: jsonSchema<{ marker: string }>({
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
        additionalProperties: false,
      }),
    }),
  };
  const marker = { openrouter: { cacheControl: { type: "ephemeral" } } };
  const anthropic = modelId.startsWith("anthropic/");
  const summarize = (variant: Row["variant"]) =>
    summarizeCacheRows(rows.filter((r) => r.variant === variant));
  const save = () =>
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          model: modelId,
          scope,
          runId,
          pairs,
          rows,
          baseline: summarize("baseline"),
          treatment: summarize("treatment"),
          limitation:
            "Synthetic short-run observation, not causal production savings. Separate randomized prefixes prevent cross-arm warming; backend load and routing can differ. No retries; absent usage and cost stay unknown.",
        },
        null,
        2,
      ),
    );

  for (let pair = 0; pair < pairs; pair++) {
    const order: Row["variant"][] =
      pair % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
    for (const variant of order) {
      const conversationId = randomUUID();
      const sessionId = createOpenRouterCacheSessionId({
        chatId: conversationId,
        mode: `cache-benchmark-${scope}`,
        requestedModelSlug: modelId,
      });
      // A unique early prefix gives each arm an independent cold cache. Same size
      // and structure; never compare a cold baseline to its warmed identical copy.
      const system =
        `Synthetic session ${conversationId}. Call report with the current marker. Initially CACHE_0. After each tool result use its next marker. Do not inspect URLs or execute any commands.\n` +
        Array.from(
          { length: 180 },
          (_, i) =>
            `Reference ${i}: synthetic inventory record. Preserve the user's scope, current instructions and tool results. No external actions are authorized. Record status is healthy.`,
        ).join("\n");
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: "Report the current marker.",
          ...(anthropic &&
            variant === "baseline" && { providerOptions: marker }),
        },
      ];
      const cacheOptions =
        variant === "treatment"
          ? buildPromptCacheOptions(modelId, sessionId)
          : baselineCacheOptions(modelId, sessionId, scope);
      const providerOptions = direct
        ? cacheOptions
        : {
            openrouter: {
              provider: getOpenRouterProviderRoutingForModel(modelId),
              ...("openrouter" in cacheOptions ? cacheOptions.openrouter : {}),
            },
          };
      for (let step = 0; step < 3; step++) {
        if (deadline.aborted) throw new Error("Benchmark deadline reached");
        if (rows.reduce((sum, r) => sum + (r.cost ?? 0), 0) > 1)
          throw new Error("Reported spend limit reached");
        const started = performance.now();
        try {
          const result = await generateText({
            model,
            system: anthropic
              ? { role: "system", content: system, providerOptions: marker }
              : system,
            messages:
              variant === "treatment"
                ? addPromptCacheBreakpoints(messages, modelId)
                : messages,
            tools,
            toolChoice: { type: "tool", toolName: "report" },
            providerOptions,
            maxOutputTokens: 512,
            maxRetries: 0,
            abortSignal: AbortSignal.any([
              deadline,
              AbortSignal.timeout(45_000),
            ]),
          });
          const call = result.toolCalls[0];
          const valid =
            result.toolCalls.length === 1 &&
            call.toolName === "report" &&
            typeof call.input === "object" &&
            call.input !== null &&
            "marker" in call.input &&
            call.input.marker === `CACHE_${step}`;
          const raw = result.usage.raw as Record<string, unknown> | undefined;
          const costDetails = raw?.cost_details as
            Record<string, unknown> | undefined;
          const responseBody = result.response.body as
            { provider?: string } | undefined;
          const requestBody = (
            typeof result.request.body === "string"
              ? JSON.parse(result.request.body)
              : result.request.body
          ) as { session_id?: string; prompt_cache_key?: string } | undefined;
          const row: Row = {
            pair,
            variant,
            step,
            input: finite(result.usage.inputTokens),
            cached: finite(result.usage.inputTokenDetails.cacheReadTokens),
            written: finite(result.usage.inputTokenDetails.cacheWriteTokens),
            output: finite(result.usage.outputTokens),
            cost:
              finite(raw?.cost) ?? finite(costDetails?.upstream_inference_cost),
            elapsedMs: Math.round(performance.now() - started),
            valid,
            generationId: result.response.id,
            servedModel: result.response.modelId,
            servedProvider: responseBody?.provider,
            affinityHintSent: Boolean(
              requestBody?.session_id || requestBody?.prompt_cache_key,
            ),
            explicitCacheBreakpoints:
              JSON.stringify(requestBody ?? {}).match(/"cache_control":/g)
                ?.length ?? 0,
          };
          rows.push(row);
          console.log(JSON.stringify(row));
          save();
          if (!valid) break;
          messages.push(...result.response.messages, {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: "report",
                output: {
                  type: "text",
                  value:
                    Array.from(
                      { length: 70 },
                      (_, i) =>
                        `Synthetic tool record ${step}-${i}: check completed successfully; no further action needed.`,
                    ).join("\n") +
                    `\nThe next marker is CACHE_${step + 1}. Call report with this exact marker.`,
                },
              },
            ],
          });
        } catch (error) {
          // SDK errors can include request bodies/headers: never print them.
          const status = (error as { statusCode?: number }).statusCode;
          rows.push({
            pair,
            variant,
            step,
            input: null,
            cached: null,
            written: null,
            output: null,
            cost: null,
            elapsedMs: Math.round(performance.now() - started),
            valid: false,
            error: status
              ? `HTTP ${status}`
              : "request failed or deadline/spend guard reached",
          });
          save();
          break;
        }
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        baseline: summarize("baseline"),
        treatment: summarize("treatment"),
        outputPath,
      },
      null,
      2,
    ),
  );
  if (rows.some((r) => !r.valid)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("benchmark-prompt-cache.ts")) {
  main().catch(() => {
    console.error(
      "Cache benchmark stopped. Check arguments, model credentials and the sanitized artifact; no request details were logged.",
    );
    process.exitCode = 1;
  });
}
