import { customProvider } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

export const myProvider = customProvider({
  languageModels: {
    "agent-model": openrouter("anthropic/claude-sonnet-4"),
    "title-generator-model": openrouter("openai/gpt-4o-mini"),
  },
});
