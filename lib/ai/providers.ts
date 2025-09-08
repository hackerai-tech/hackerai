import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { gateway } from "@ai-sdk/gateway";

export const myProvider = customProvider({
  languageModels: {
    "ask-model": gateway(
      process.env.NEXT_PUBLIC_ASK_MODEL || "deepseek/deepseek-v3",
    ),
    "agent-model": openrouter(
      process.env.NEXT_PUBLIC_AGENT_MODEL || "qwen/qwen3-coder",
    ),
    "vision-model": gateway(
      process.env.NEXT_PUBLIC_VISION_MODEL || "google/gemini-2.5-flash",
    ),
    "vision-base64-model": openrouter(
      process.env.NEXT_PUBLIC_VISION_BASE64_MODEL || "google/gemini-2.5-flash",
    ),
    "title-generator-model": gateway(
      process.env.NEXT_PUBLIC_TITLE_MODEL || "google/gemini-2.5-flash",
    ),
  },
});
