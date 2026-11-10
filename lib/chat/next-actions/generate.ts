import { generateText } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";
import {
  parsePredictedNextAction,
  hasExplicitPredictionStop,
  type PredictionSource,
} from "./contracts";

// T3 Code Codex predictor, copied verbatim under MIT; see third_party/t3code/LICENSE.
// https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L237
const SYSTEM =
  "Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.";

/** One small utility generation using T3 Code's next-message prediction prompt.
 * No tools, supporting-quote generation or second semantic-verification call. */
export async function generateNextActions(
  sources: PredictionSource[],
  signal: AbortSignal,
) {
  const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  let attempted = false;
  let suggestions: string[] = [];
  let unavailable = false;
  let cost: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let modelId: string | undefined;
  try {
    abortSignal.throwIfAborted();
    if (!hasExplicitPredictionStop(sources)) {
      attempted = true;
      const result = await generateText({
        model: myProvider.languageModel(DEEPSEEK_1017_MODEL_KEY),
        providerOptions: {
          openrouter: {
            reasoning: { enabled: false },
            provider: { require_parameters: true, sort: "throughput" },
          },
        },
        system: SYSTEM,
        prompt: JSON.stringify(
          sources.map(({ role, text }) => ({ role, text })),
        ),
        temperature: 0,
        maxOutputTokens: 160,
        maxRetries: 0,
        timeout: 8_000,
        abortSignal,
      });
      // Keep the receipt even if cancellation wins after the provider finishes.
      cost = getProviderUsageRawModelCost(result.usage.raw);
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
      reasoningTokens = result.usage.outputTokenDetails.reasoningTokens;
      modelId = result.response.modelId;
      abortSignal.throwIfAborted();
      suggestions = parsePredictedNextAction({
        suggestion: result.text.trim() || null,
      });
    }
  } catch {
    unavailable = true;
    suggestions = [];
  }
  const providerCalls = Number(attempted);
  const pricedProviderCalls = Number(attempted && cost !== undefined);
  return {
    suggestions,
    unavailable,
    inputTokens,
    outputTokens,
    reasoningTokens,
    modelId,
    modelIds: modelId ? [modelId] : [],
    providerCalls,
    pricedProviderCalls,
    unknownProviderCalls: providerCalls - pricedProviderCalls,
    knownCost: cost ?? 0,
    cost,
  };
}
