import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
// import { withTracing } from "@posthog/ai";
// import PostHogClient from "@/app/posthog";
// import type { SubscriptionTier } from "@/types";

const baseProviders = {
  "ask-model": openrouter("google/gemini-3-flash-preview"),
  "ask-model-free": openrouter("x-ai/grok-4.1-fast"),
  "agent-model": openrouter("moonshotai/kimi-k2.5"),
  "model-codex-5.3": openrouter("openai/gpt-5.3-codex"),
  "model-opus-4.6": openrouter("anthropic/claude-opus-4.6"),
  "model-sonnet-4.6": openrouter("anthropic/claude-sonnet-4-6"),
  "model-gemini-3.1-pro": openrouter("google/gemini-3.1-pro-preview"),
  "model-grok-4.1": openrouter("x-ai/grok-4.1-fast"),
  "model-gemini-3-flash": openrouter("google/gemini-3-flash-preview"),
  "model-kimi-k2.5": openrouter("moonshotai/kimi-k2.5"),
  "fallback-agent-model": openrouter("google/gemini-3-flash-preview"),
  "fallback-ask-model": openrouter("moonshotai/kimi-k2.5"),
  "title-generator-model": openrouter("x-ai/grok-4.1-fast"),
} as Record<string, any>;

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "November 2024",
  "agent-model": "January 2025",
  "model-codex-5.3": "January 2025",
  "model-opus-4.6": "May 2025",
  "model-sonnet-4.6": "May 2025",
  "model-gemini-3.1-pro": "January 2025",
  "model-grok-4.1": "November 2024",
  "model-gemini-3-flash": "January 2025",
  "model-kimi-k2.5": "January 2025",
  "fallback-agent-model": "January 2025",
  "fallback-ask-model": "January 2025",
  "title-generator-model": "November 2024",
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
