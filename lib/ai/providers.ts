import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
    "qwen/qwen3-coder": openrouter("qwen/qwen3-coder"),
    "title-generator-model": openrouter("qwen/qwen3-coder"),
  },
});
