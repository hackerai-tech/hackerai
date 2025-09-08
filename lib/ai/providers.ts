import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { gateway } from '@ai-sdk/gateway';

export const myProvider = customProvider({
  languageModels: {
    "ask-model": openrouter(
      process.env.NEXT_PUBLIC_ASK_MODEL || "deepseek/deepseek-chat-v3-0324",
    ),
    "agent-model": gateway(
      process.env.NEXT_PUBLIC_AGENT_MODEL || "alibaba/qwen3-coder",
    ),
    "vision-model": openrouter(
      process.env.NEXT_PUBLIC_VISION_MODEL || "google/gemini-2.5-flash",
    ),
    "title-generator-model": gateway(
      process.env.NEXT_PUBLIC_TITLE_MODEL || "google/gemini-2.5-flash",
    ),
  },
});
