import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
    "ask-model": openrouter(
      process.env.NEXT_PUBLIC_ASK_MODEL || "deepseek/deepseek-chat-v3-0324",
    ),
    "agent-model": openrouter(
      process.env.NEXT_PUBLIC_AGENT_MODEL || "qwen/qwen3-coder",
    ),
    "vision-model": openrouter(
      process.env.NEXT_PUBLIC_VISION_MODEL || "google/gemini-2.5-flash",
    ),
    "title-generator-model": openrouter(
      process.env.NEXT_PUBLIC_TITLE_MODEL || "google/gemini-2.5-flash",
    ),
  },
});
