import { customProvider } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
// import { withTracing } from "@posthog/ai";
// import PostHogClient from "@/app/posthog";
// import type { SubscriptionTier } from "@/types";

// Custom fetch that patches assistant tool-call messages for Kimi K2.5.
// When reasoning mode is enabled, Kimi's API requires a `reasoning` field
// on every assistant message with tool_calls, but the AI SDK doesn't always
// include it (e.g. model made a tool call without emitting reasoning tokens).
const openrouter = createOpenRouter({
  fetch: async (url, init) => {
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
  },
});

const baseProviders = {
  "ask-model": openrouter("google/gemini-3-flash-preview"),
  "ask-model-free": openrouter("x-ai/grok-4.1-fast"),
  "agent-model": openrouter("moonshotai/kimi-k2.5"),
  "model-sonnet-4.6": openrouter("anthropic/claude-sonnet-4-6"),
  "model-grok-4.1": openrouter("x-ai/grok-4.1-fast"),
  "model-gemini-3-flash": openrouter("google/gemini-3-flash-preview"),
  // "model-opus-4.6": openrouter("anthropic/claude-opus-4.6"),
  "model-gpt-5.4": openrouter("openai/gpt-5.4"),
  "model-kimi-k2.5": openrouter("moonshotai/kimi-k2.5"),
  "fallback-agent-model": openrouter("x-ai/grok-4.1-fast"),
  "fallback-ask-model": openrouter("x-ai/grok-4.1-fast"),
  "title-generator-model": openrouter("x-ai/grok-4.1-fast"),
} as Record<string, any>;

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "November 2024",
  "agent-model": "April 2024",
  "model-sonnet-4.6": "May 2025",
  "model-grok-4.1": "November 2024",
  "model-gemini-3-flash": "January 2025",
  // "model-opus-4.6": "May 2025",
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
  "model-sonnet-4.6": "Anthropic Claude Sonnet 4.6",
  "model-grok-4.1": "xAI Grok 4.1 Fast",
  "model-gemini-3-flash": "Google Gemini 3 Flash",
  // "model-opus-4.6": "Anthropic Claude Opus 4.6",
  "model-gpt-5.4": "OpenAI GPT-5.4",
  "model-kimi-k2.5": "Moonshot Kimi K2.5",
  "fallback-agent-model": "Auto, an intelligent model router built by HackerAI",
  "fallback-ask-model": "Auto, an intelligent model router built by HackerAI",
  "title-generator-model":
    "Auto, an intelligent model router built by HackerAI",
  "model-codex-local": "OpenAI Codex (Your Account)",
};

export const getModelDisplayName = (modelName: ModelName): string => {
  return modelDisplayNames[modelName];
};

export const getModelCutoffDate = (modelName: ModelName): string => {
  return modelCutoffDates[modelName];
};

export const myProvider = customProvider({
  languageModels: baseProviders,
});

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
