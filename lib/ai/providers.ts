import { customProvider } from "ai";
import { xai } from "@ai-sdk/xai";
import { withTracing } from "@posthog/ai";
import PostHogClient from "@/app/posthog";
import type { SubscriptionTier } from "@/types";
import { gateway } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

const baseProviders = {
  "ask-model": openrouter("google/gemini-3-flash-preview"),
  "ask-model-free": xai("grok-4-1-fast-non-reasoning"),
  "ask-vision-model": openrouter("google/gemini-3-flash-preview"),
  "ask-vision-model-for-pdfs": openrouter("google/gemini-3-flash-preview"),
  "agent-model": gateway("google/gemini-3-flash"),
  "agent-vision-model": gateway("google/gemini-3-flash"),
  "title-generator-model": xai("grok-4-1-fast-non-reasoning"),
  "summarization-model": openrouter("google/gemini-3-flash-preview"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as Record<string, any>;

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "November 2024",
  "ask-vision-model": "January 2025",
  "ask-vision-model-for-pdfs": "January 2025",
  "agent-model": "January 2025",
  "agent-vision-model": "January 2025",
  "title-generator-model": "November 2024",
  "summarization-model": "January 2025",
};

export const getModelCutoffDate = (modelName: ModelName): string => {
  return modelCutoffDates[modelName];
};

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = (
  userId?: string,
  conversationId?: string,
  subscription?: SubscriptionTier,
  phClient?: ReturnType<typeof PostHogClient> | null,
) => {
  // Only use tracing for non-free users
  if (!phClient || subscription === "free") {
    return myProvider;
  }

  const trackedModels: Record<string, any> = {};

  Object.entries(baseProviders).forEach(([modelName, model]) => {
    trackedModels[modelName] = withTracing(model, phClient, {
      ...(userId && { posthogDistinctId: userId }),
      posthogProperties: {
        modelType: modelName,
        ...(conversationId && { conversationId }),
        subscriptionTier: subscription,
      },
      posthogPrivacyMode: true,
    });
  });

  return customProvider({
    languageModels: trackedModels,
  });
};
