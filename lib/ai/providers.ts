import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
    "qwen/qwen3-coder": openrouter(
      process.env.NEXT_PUBLIC_AGENT_MODEL || "qwen/qwen3-coder",
    ),
    "title-generator-model": openrouter(
      process.env.NEXT_PUBLIC_TITLE_MODEL || "qwen/qwen3-30b-a3b",
    ),
  },
});
