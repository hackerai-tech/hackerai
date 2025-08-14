import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
    "agent-model": openrouter("qwen/qwen3-coder"),
    "title-generator-model": openrouter("qwen/qwen3-coder"),
  },
});
