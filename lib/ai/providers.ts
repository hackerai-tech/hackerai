import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { openai } from "@ai-sdk/openai";
import { xai } from "@ai-sdk/xai";
import { withTracing } from "@posthog/ai";
import PostHogClient from "@/app/posthog";
import type { SubscriptionTier } from "@/types";

const baseProviders = {
  "ask-model": openrouter("qwen/qwen3-coder"),
  "ask-model-free": openrouter("qwen/qwen3-235b-a22b-2507"),
  "agent-model": xai("grok-code-fast-1"),
  "agent-model-with-vision": xai("grok-4-fast-reasoning"),
  "vision-model": openrouter("qwen/qwen3-vl-235b-a22b-instruct"),
  "vision-model-for-pdfs": openai("gpt-4.1-2025-04-14"),
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
