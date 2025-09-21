import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { openai } from "@ai-sdk/openai";
import { withTracing } from "@posthog/ai";
import PostHogClient from "@/app/posthog";

const baseProviders = {
  "ask-model": openrouter(
    process.env.NEXT_PUBLIC_ASK_MODEL || "deepseek/deepseek-chat-v3-0324",
  ),
  "agent-model": openai(process.env.NEXT_PUBLIC_AGENT_MODEL || "gpt-5-mini"),
  "vision-model": openai(
    process.env.NEXT_PUBLIC_VISION_MODEL || "gpt-5-2025-08-07",
  ),
  "title-generator-model": openrouter(
    process.env.NEXT_PUBLIC_TITLE_MODEL || "google/gemini-2.5-flash",
  ),
};

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = (
  userId?: string,
  conversationId?: string,
  isPro?: boolean,
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
        subscriptionTier: isPro ? "pro" : "free",
      },
      posthogPrivacyMode: true,
    });
  });

  return customProvider({
    languageModels: trackedModels,
  });
};
