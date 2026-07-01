import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ChatMode, SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_BASE_URL,
});

const deepseekModel = deepseek(DEEPSEEK_MODEL);

/**
 * All tiers/modes route to the same DeepSeek model. The key set is kept
 * stable (rather than collapsed to a single key) because usage tracking,
 * rate limiting, and cost accounting elsewhere key off of these names.
 */
const baseProviders = {
  "ask-model": deepseekModel,
  "ask-model-free": deepseekModel,
  "agent-model": deepseekModel,
  "agent-model-free": deepseekModel,
  "model-sonnet-4.6": deepseekModel,
  "model-grok-4.3": deepseekModel,
  "model-gemini-3-flash": deepseekModel,
  "model-deepseek-v4-flash": deepseekModel,
  "model-deepseek-v4-pro": deepseekModel,
  "model-opus-4.6": deepseekModel,
  "model-minimax-m3": deepseekModel,
  "model-kimi-k2.7-code": deepseekModel,
  "model-kimi-k2.6": deepseekModel,
  "fallback-agent-model": deepseekModel,
  "fallback-ask-model": deepseekModel,
  "fallback-gemini-3.5-flash": deepseekModel,
  "fallback-grok-4.3": deepseekModel,
  "title-generator-model": deepseekModel,
} as Record<string, any>;

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "May 2025",
  "ask-model-free": "May 2025",
  "agent-model": "May 2025",
  "agent-model-free": "May 2025",
  "model-sonnet-4.6": "May 2025",
  "model-grok-4.3": "May 2025",
  "model-gemini-3-flash": "May 2025",
  "model-deepseek-v4-flash": "May 2025",
  "model-deepseek-v4-pro": "May 2025",
  "model-opus-4.6": "May 2025",
  "model-minimax-m3": "May 2025",
  "model-kimi-k2.7-code": "May 2025",
  "model-kimi-k2.6": "May 2025",
  "fallback-agent-model": "May 2025",
  "fallback-ask-model": "May 2025",
  "fallback-gemini-3.5-flash": "May 2025",
  "fallback-grok-4.3": "May 2025",
  "title-generator-model": "May 2025",
};

export const modelDisplayNames: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "DeepSeek",
  "ask-model-free": "DeepSeek",
  "agent-model": "DeepSeek",
  "agent-model-free": "DeepSeek",
  "model-sonnet-4.6": "DeepSeek",
  "model-grok-4.3": "DeepSeek",
  "model-gemini-3-flash": "DeepSeek",
  "model-deepseek-v4-flash": "DeepSeek",
  "model-deepseek-v4-pro": "DeepSeek",
  "model-opus-4.6": "DeepSeek",
  "model-minimax-m3": "DeepSeek",
  "model-kimi-k2.7-code": "DeepSeek",
  "model-kimi-k2.6": "DeepSeek",
  "fallback-agent-model": "DeepSeek",
  "fallback-ask-model": "DeepSeek",
  "fallback-gemini-3.5-flash": "DeepSeek",
  "fallback-grok-4.3": "DeepSeek",
  "title-generator-model": "DeepSeek",
};

export const getModelDisplayName = (modelName: ModelName): string => {
  return modelDisplayNames[modelName];
};

export const getModelCutoffDate = (modelName: ModelName): string => {
  return modelCutoffDates[modelName];
};

/** All models route through the DeepSeek OpenAI-compatible chat API. */
export function isDeepSeekModel(_modelName: string): boolean {
  return true;
}

/**
 * DeepSeek's chat completions API does not return multimodal tool results.
 */
export function supportsMultimodalToolResults(_modelName?: string): boolean {
  return false;
}

/**
 * Map a HackerAI tier id to the underlying provider key for a given mode.
 * Returns `null` for `"auto"` (the caller routes to the auto-router model
 * key instead). All tiers resolve to the same DeepSeek model; the distinct
 * keys are kept for usage tracking and rate limiting.
 */
export function resolveTierToProviderKey(
  tier: SelectedModel,
  mode: ChatMode,
): ModelName | null {
  if (tier === "auto") return null;
  switch (tier) {
    case "hackerai-standard":
      return isAgentMode(mode) ? "model-minimax-m3" : "model-deepseek-v4-pro";
    case "hackerai-pro":
      return "model-sonnet-4.6";
    case "hackerai-max":
      return "model-opus-4.6";
  }
}

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = () => myProvider;
