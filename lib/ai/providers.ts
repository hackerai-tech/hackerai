import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { withTracing } from "@posthog/ai";
import PostHogClient from "@/app/posthog";

const baseProviders = {
  "ask-model": openrouter(
    process.env.NEXT_PUBLIC_ASK_MODEL || "qwen/qwen3-coder",
  ),
  "agent-model": openrouter(
    process.env.NEXT_PUBLIC_AGENT_MODEL || "qwen/qwen3-coder",
  ),
  "vision-model": openrouter(
    process.env.NEXT_PUBLIC_VISION_MODEL || "google/gemini-2.5-flash",
  ),
  "vision-base64-model": openrouter(
    process.env.NEXT_PUBLIC_VISION_BASE64_MODEL || "google/gemini-2.5-flash",
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
