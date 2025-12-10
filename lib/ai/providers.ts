import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { xai } from "@ai-sdk/xai";
import { google } from "@ai-sdk/google";
import { withTracing } from "@posthog/ai";
import PostHogClient from "@/app/posthog";
import type { SubscriptionTier } from "@/types";

const baseProviders = {
  "ask-model": openrouter("google/gemini-2.5-flash-preview-09-2025"),
  "ask-model-free": openrouter("google/gemini-2.5-flash-preview-09-2025"),
  "ask-vision-model": openrouter("google/gemini-2.5-flash-preview-09-2025"),
  "ask-vision-model-for-pdfs": openrouter(
    "google/gemini-2.5-flash-preview-09-2025",
  ),
  "agent-model": xai("grok-code-fast-1"),
  "agent-vision-model": xai("grok-4-fast-reasoning"),
  "title-generator-model": xai("grok-4-1-fast-non-reasoning"),
  "summarization-model": xai("grok-4-1-fast-non-reasoning"),
};

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "January 2025",
  "ask-vision-model": "January 2025",
  "ask-vision-model-for-pdfs": "January 2025",
  "agent-model": "November 2024",
  "agent-vision-model": "November 2024",
  "title-generator-model": "November 2024",
  "summarization-model": "November 2024",
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
