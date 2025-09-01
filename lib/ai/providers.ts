import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
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
