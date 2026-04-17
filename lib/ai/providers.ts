import { customProvider } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
// import { withTracing } from "@posthog/ai";
// import PostHogClient from "@/app/posthog";
// import type { SubscriptionTier } from "@/types";

// Custom fetch that patches assistant tool-call messages for Kimi K2.5.
// When reasoning mode is enabled, Kimi's API requires a `reasoning` field
// on every assistant message with tool_calls, but the AI SDK doesn't always
// include it (e.g. model made a tool call without emitting reasoning tokens).
const kimiReasoningPatchFetch: typeof fetch = async (url, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      if (Array.isArray(body.messages) && body.reasoning?.enabled === true) {
        for (const msg of body.messages) {
          if (
            msg.role === "assistant" &&
            Array.isArray(msg.tool_calls) &&
            msg.tool_calls.length > 0 &&
            !msg.reasoning
          ) {
            msg.reasoning = ".";
          }
        }
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // If parsing fails, send the request as-is
    }
  }
  return globalThis.fetch(url, init);
};

const openrouter = createOpenRouter({ fetch: kimiReasoningPatchFetch });

type OpenRouterInstance = typeof openrouter;

const buildProviderMap = (or: OpenRouterInstance) =>
  ({
    "ask-model": or("google/gemini-3-flash-preview"),
    "ask-model-free": or("x-ai/grok-4.1-fast"),
    "agent-model": or("moonshotai/kimi-k2.5:exacto"),
    "agent-model-free": or("moonshotai/kimi-k2.5:exacto"),
    "model-sonnet-4.6": or("anthropic/claude-sonnet-4-6"),
    "model-grok-4.1": or("x-ai/grok-4.1-fast"),
    "model-gemini-3-flash": or("google/gemini-3-flash-preview"),
    "model-opus-4.6": or("anthropic/claude-opus-4-6"),
    "model-opus-4.7": or("anthropic/claude-opus-4-7"),
    "model-gpt-5.4": or("openai/gpt-5.4"),
    "model-kimi-k2.5": or("moonshotai/kimi-k2.5:exacto"),
    "fallback-agent-model": or("x-ai/grok-4.1-fast"),
    "fallback-ask-model": or("x-ai/grok-4.1-fast"),
    "title-generator-model": or("x-ai/grok-4.1-fast"),
  }) as Record<string, any>;

const baseProviders = buildProviderMap(openrouter);

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "November 2024",
  "agent-model": "April 2024",
  "agent-model-free": "April 2024",
  "model-sonnet-4.6": "May 2025",
  "model-grok-4.1": "November 2024",
  "model-gemini-3-flash": "January 2025",
  "model-opus-4.6": "May 2025",
  "model-opus-4.7": "January 2026",
  "model-gpt-5.4": "August 2025",
  "model-kimi-k2.5": "April 2024",
  "fallback-agent-model": "January 2025",
  "fallback-ask-model": "January 2025",
  "title-generator-model": "November 2024",
  "model-codex-local": "April 2025",
};

export const modelDisplayNames: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "Auto, an intelligent model router built by HackerAI",
  "ask-model-free": "Auto, an intelligent model router built by HackerAI",
  "agent-model": "Auto, an intelligent model router built by HackerAI",
  "agent-model-free": "Auto, an intelligent model router built by HackerAI",
  "model-sonnet-4.6": "Anthropic Claude Sonnet 4.6",
  "model-grok-4.1": "xAI Grok 4.1 Fast",
  "model-gemini-3-flash": "Google Gemini 3 Flash",
  "model-opus-4.6": "Anthropic Claude Opus 4.6",
  "model-opus-4.7": "Anthropic Claude Opus 4.7",
  "model-gpt-5.4": "OpenAI GPT-5.4",
  "model-kimi-k2.5": "Moonshot Kimi K2.5",
  "fallback-agent-model": "Auto, an intelligent model router built by HackerAI",
  "fallback-ask-model": "Auto, an intelligent model router built by HackerAI",
  "title-generator-model":
    "Auto, an intelligent model router built by HackerAI",
  "model-codex-local": "OpenAI Codex (Your Account)",
};

/**
 * Maximum context window (in tokens) per model, as advertised by the provider.
 * Used when "Max Mode" is enabled to unlock the model's full native context.
 * Sourced from OpenRouter model pages.
 */
export const MODEL_CONTEXT_WINDOWS: Record<ModelName, number> &
  Record<string, number> = {
  "ask-model": 1_048_576, // resolves to Gemini 3 Flash
  "ask-model-free": 2_000_000, // resolves to Grok 4.1 Fast
  "agent-model": 262_144, // resolves to Kimi K2.5
  "agent-model-free": 262_144, // resolves to Kimi K2.5
  "model-sonnet-4.6": 1_000_000, // Claude Sonnet 4.6 with 1M context beta
  "model-grok-4.1": 2_000_000, // Grok 4.1 Fast
  "model-gemini-3-flash": 1_048_576, // Gemini 3 Flash
  "model-opus-4.6": 1_000_000, // Claude Opus 4.6 with 1M context beta
  "model-opus-4.7": 1_000_000, // Claude Opus 4.7 with 1M context beta
  "model-gpt-5.4": 1_050_000, // GPT-5.4 (922k input + 128k output)
  "model-kimi-k2.5": 262_144, // Kimi K2.5
  "fallback-agent-model": 2_000_000,
  "fallback-ask-model": 2_000_000,
  "title-generator-model": 2_000_000,
  "model-codex-local": 400_000,
};

export const getModelContextWindow = (modelName: string): number => {
  return MODEL_CONTEXT_WINDOWS[modelName] ?? 200_000;
};

export const getModelDisplayName = (modelName: ModelName): string => {
  return modelDisplayNames[modelName];
};

export const getModelCutoffDate = (modelName: ModelName): string => {
  return modelCutoffDates[modelName];
};

export function isAnthropicModel(modelName: string): boolean {
  return modelName.includes("sonnet") || modelName.includes("opus");
}

export const myProvider = customProvider({
  languageModels: baseProviders,
});

/**
 * Create an OpenRouter provider using a user-supplied API key (BYOK).
 * Routes through the same model map as the default provider, so existing
 * model selection logic works unchanged. LLM costs bill to the user's
 * OpenRouter account instead of HackerAI's.
 */
export function createByokTrackedProvider(apiKey: string) {
  const byokOpenRouter = createOpenRouter({
    apiKey,
    fetch: kimiReasoningPatchFetch,
  });
  return customProvider({ languageModels: buildProviderMap(byokOpenRouter) });
}

export const createTrackedProvider = () =>
  // userId?: string,
  // conversationId?: string,
  // subscription?: SubscriptionTier,
  // phClient?: ReturnType<typeof PostHogClient> | null,
  {
    // PostHog provider tracking disabled
    // if (!phClient || subscription === "free") {
    //   return myProvider;
    // }
    //
    // const trackedModels: Record<string, any> = {};
    //
    // Object.entries(baseProviders).forEach(([modelName, model]) => {
    //   trackedModels[modelName] = withTracing(model, phClient, {
    //     ...(userId && { posthogDistinctId: userId }),
    //     posthogProperties: {
    //       modelType: modelName,
    //       ...(conversationId && { conversationId }),
    //       subscriptionTier: subscription,
    //     },
    //     posthogPrivacyMode: true,
    //   });
    // });
    //
    // return customProvider({
    //   languageModels: trackedModels,
    // });

    return myProvider;
  };
