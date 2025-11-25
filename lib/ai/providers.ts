import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { openai } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
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
  "title-generator-model": openai("gpt-4.1-mini-2025-04-14"),
  "summarization-model": xai("grok-4-fast-non-reasoning"),
};

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = (
  userId?: string,
  conversationId?: string,
  subscription?: SubscriptionTier,
) => {
  const phClient = PostHogClient();

  if (!phClient) {
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
