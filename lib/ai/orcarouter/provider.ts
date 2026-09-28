import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider, NoSuchModelError } from "ai";
import {
  getOrcaRouterModelId,
  isOrcaRouterModelKey,
} from "@/lib/ai/orcarouter/models";

export type OrcaRouterFallbackProvider = NonNullable<
  Parameters<typeof customProvider>[0]["fallbackProvider"]
>;

/**
 * Per-request OrcaRouter provider built from the user's own key. It resolves
 * only `orcarouter:<vendor/model>` keys and is used as the fallback for the
 * static HackerAI provider map, so every other model keeps its route.
 */
export function createOrcaRouterProvider({
  apiKey,
  apiBaseUrl,
  onUnauthorized,
  fetchImpl,
}: {
  apiKey: string;
  apiBaseUrl: string;
  /** Called once when the relay rejects the key (revoked or deleted). */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}): OrcaRouterFallbackProvider {
  let reportedUnauthorized = false;
  const orcarouter = createOpenAICompatible({
    name: "orcarouter",
    baseURL: apiBaseUrl,
    apiKey,
    includeUsage: true,
    fetch: async (input, init) => {
      const response = await (fetchImpl ?? fetch)(input, init);
      if (response.status === 401 && !reportedUnauthorized) {
        reportedUnauthorized = true;
        onUnauthorized?.();
      }
      return response;
    },
  });

  const resolve = (modelKey: string) => {
    if (!isOrcaRouterModelKey(modelKey)) {
      throw new NoSuchModelError({
        modelId: modelKey,
        modelType: "languageModel",
      });
    }
    return getOrcaRouterModelId(modelKey);
  };

  return {
    specificationVersion: "v3",
    languageModel: (modelKey) => orcarouter.languageModel(resolve(modelKey)),
    embeddingModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
  };
}
