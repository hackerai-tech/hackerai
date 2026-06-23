import { customProvider } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ChatMode, SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { openrouterAttributionHeaders } from "@/lib/ai/openrouter-attribution";
// import { withTracing } from "@posthog/ai";
// import PostHogClient from "@/app/posthog";
// import type { SubscriptionTier } from "@/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isXaiModelSlug = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().startsWith("x-ai/");

const isGeminiModelSlug = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().startsWith("google/gemini");

const requestCanRouteToXai = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (isXaiModelSlug(body.model)) return true;
  return Array.isArray(body.models) && body.models.some(isXaiModelSlug);
};

const requestCanRouteToGemini = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (isGeminiModelSlug(body.model)) return true;
  return Array.isArray(body.models) && body.models.some(isGeminiModelSlug);
};

const hasOwnEncryptedContent = (value: unknown): boolean =>
  isRecord(value) && Object.hasOwn(value, "encrypted_content");

const stripEncryptedContent = (
  value: unknown,
  inReasoningDetails = false,
): { value: unknown; changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const cleaned: unknown[] = [];

    for (const item of value) {
      if (inReasoningDetails && hasOwnEncryptedContent(item)) {
        changed = true;
        continue;
      }
      const result = stripEncryptedContent(item, inReasoningDetails);
      changed ||= result.changed;
      cleaned.push(result.value);
    }

    return changed ? { value: cleaned, changed } : { value, changed: false };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const cleaned: Record<string, unknown> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (inReasoningDetails && key === "encrypted_content") {
      changed = true;
      continue;
    }

    const nextInReasoningDetails =
      inReasoningDetails || key === "reasoning_details";
    const result = stripEncryptedContent(entryValue, nextInReasoningDetails);
    changed ||= result.changed;

    if (
      key === "reasoning_details" &&
      Array.isArray(result.value) &&
      result.value.length === 0
    ) {
      changed = true;
      continue;
    }

    cleaned[key] = result.value;
  }

  return changed ? { value: cleaned, changed } : { value, changed: false };
};

export const sanitizeOpenRouterRequestForXai = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (
    !isRecord(body) ||
    !requestCanRouteToXai(body) ||
    !Array.isArray(body.messages)
  ) {
    return { body, changed: false };
  }

  let changed = false;
  const messages = body.messages.map((message) => {
    const result = stripEncryptedContent(message);
    changed ||= result.changed;
    return result.value;
  });

  if (!changed) return { body, changed: false };
  return { body: { ...body, messages }, changed: true };
};

const hasJsonRefKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasJsonRefKey);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "$ref")) return true;
  return Object.values(value).some(hasJsonRefKey);
};

const wrapToolContentIfGeminiRefSensitive = (
  content: unknown,
): { content: unknown; changed: boolean } => {
  if (typeof content !== "string" || !content.includes('"$ref"')) {
    return { content, changed: false };
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!hasJsonRefKey(parsed)) return { content, changed: false };
  } catch {
    return { content, changed: false };
  }

  return {
    content: JSON.stringify({ result: content }),
    changed: true,
  };
};

export const sanitizeOpenRouterRequestForGeminiFunctionResponses = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (
    !isRecord(body) ||
    !requestCanRouteToGemini(body) ||
    !Array.isArray(body.messages)
  ) {
    return { body, changed: false };
  }

  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    const result = wrapToolContentIfGeminiRefSensitive(message.content);
    if (!result.changed) return message;
    changed = true;
    return { ...message, content: result.content };
  });

  if (!changed) return { body, changed: false };
  return { body: { ...body, messages }, changed: true };
};

const patchKimiReasoningToolCalls = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body)) return { body, changed: false };
  if (
    !Array.isArray(body.messages) ||
    !isRecord(body.reasoning) ||
    body.reasoning.enabled !== true
  ) {
    return { body, changed: false };
  }

  let changed = false;
  const messages = body.messages.map((message) => {
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      !message.reasoning
    ) {
      changed = true;
      return { ...message, reasoning: "." };
    }
    return message;
  });

  return changed
    ? { body: { ...body, messages }, changed: true }
    : { body, changed: false };
};

const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Experimental-Metadata";

const withOpenRouterMetadataHeader = (
  headers: HeadersInit | undefined,
): Headers => {
  const nextHeaders = new Headers(headers);
  if (!nextHeaders.has(OPENROUTER_METADATA_HEADER)) {
    nextHeaders.set(OPENROUTER_METADATA_HEADER, "enabled");
  }
  return nextHeaders;
};

// Custom fetch for OpenRouter provider-specific request-body repairs.
//
// - Kimi requires a `reasoning` field on assistant tool-call messages when
//   reasoning mode is enabled, but the AI SDK does not always include one.
// - xAI rejects encrypted reasoning blobs generated by a different provider
//   when OpenRouter falls back to Grok. The visible assistant text remains in
//   the prompt, so these provider-private blobs are safe to omit for xAI routes.
// - Gemini 3 treats JSON `$ref` keys in function_response.response as
//   references to multimodal function_response.parts display names. OpenAPI
//   documents returned by tools can contain schema `$ref`s, so wrap those tool
//   results as text when a request can route to Gemini.
// - The metadata header opts into OpenRouter routing metadata for attribution.
const openrouterPatchFetch: typeof fetch = async (url, init) => {
  let nextInit: RequestInit = {
    ...init,
    headers: withOpenRouterMetadataHeader(init?.headers),
  };

  if (nextInit.body && typeof nextInit.body === "string") {
    try {
      const parsedBody = JSON.parse(nextInit.body) as unknown;
      const kimiPatched = patchKimiReasoningToolCalls(parsedBody);
      const xaiPatched = sanitizeOpenRouterRequestForXai(kimiPatched.body);
      const geminiPatched = sanitizeOpenRouterRequestForGeminiFunctionResponses(
        xaiPatched.body,
      );
      if (kimiPatched.changed || xaiPatched.changed || geminiPatched.changed) {
        nextInit = { ...nextInit, body: JSON.stringify(geminiPatched.body) };
      }
    } catch {
      // If parsing fails, send the request as-is
    }
  }
  return globalThis.fetch(url, nextInit);
};

const openrouter = createOpenRouter({
  fetch: openrouterPatchFetch,
  headers: openrouterAttributionHeaders,
});

type OpenRouterInstance = typeof openrouter;

const KIMI_K2_7_CODE_SLUG = "moonshotai/kimi-k2.7-code:exacto";
const GEMINI_3_5_FLASH_SLUG = "google/gemini-3.5-flash";

const buildProviderMap = (or: OpenRouterInstance) =>
  ({
    "ask-model": or(GEMINI_3_5_FLASH_SLUG),
    "ask-model-free": or("deepseek/deepseek-v4-flash"),
    "agent-model": or(KIMI_K2_7_CODE_SLUG),
    "agent-model-free": or("deepseek/deepseek-v4-flash"),
    "model-sonnet-4.6": or("anthropic/claude-sonnet-4-6"),
    "model-gemini-3-flash": or(GEMINI_3_5_FLASH_SLUG),
    "model-deepseek-v4-flash": or("deepseek/deepseek-v4-flash"),
    "model-deepseek-v4-pro": or("deepseek/deepseek-v4-pro"),
    "model-opus-4.6": or("anthropic/claude-opus-4.6"),
    "model-kimi-k2.7-code": or(KIMI_K2_7_CODE_SLUG),
    // Compatibility alias for stale internal references persisted before the
    // Kimi 2.7 Code rollout. New selections should use model-kimi-k2.7-code.
    "model-kimi-k2.6": or(KIMI_K2_7_CODE_SLUG),
    "fallback-agent-model": or("google/gemini-3-flash-preview"),
    "fallback-ask-model": or("google/gemini-3-flash-preview"),
    "fallback-gemini-3.5-flash": or("google/gemini-3.5-flash"),
    "fallback-grok-4.3": or("x-ai/grok-4.3"),
    "title-generator-model": or("google/gemini-3-flash-preview"),
  }) as Record<string, any>;

const baseProviders = buildProviderMap(openrouter);

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "January 2025",
  "ask-model-free": "May 2025",
  "agent-model": "June 2025",
  "agent-model-free": "May 2025",
  "model-sonnet-4.6": "May 2025",
  "model-gemini-3-flash": "January 2025",
  "model-deepseek-v4-flash": "May 2025",
  "model-deepseek-v4-pro": "May 2025",
  "model-opus-4.6": "May 2025",
  "model-kimi-k2.7-code": "June 2025",
  "model-kimi-k2.6": "June 2025",
  "fallback-agent-model": "January 2025",
  "fallback-ask-model": "January 2025",
  "fallback-gemini-3.5-flash": "May 2026",
  "fallback-grok-4.3": "December 2025",
  "title-generator-model": "January 2025",
};

export const modelDisplayNames: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "Auto, an intelligent model router built by HackerAI",
  "ask-model-free": "Auto, an intelligent model router built by HackerAI",
  "agent-model": "Auto, an intelligent model router built by HackerAI",
  "agent-model-free": "Auto, an intelligent model router built by HackerAI",
  "model-sonnet-4.6": "Anthropic Claude Sonnet 4.6",
  "model-gemini-3-flash": "Google Gemini 3.5 Flash",
  "model-deepseek-v4-flash": "DeepSeek V4 Flash",
  "model-deepseek-v4-pro": "DeepSeek V4 Pro",
  "model-opus-4.6": "Anthropic Claude Opus 4.6",
  "model-kimi-k2.7-code": "Moonshot Kimi K2.7 Code",
  "model-kimi-k2.6": "Moonshot Kimi K2.7 Code",
  "fallback-agent-model": "Auto, an intelligent model router built by HackerAI",
  "fallback-ask-model": "Auto, an intelligent model router built by HackerAI",
  "fallback-gemini-3.5-flash": "Google Gemini 3.5 Flash",
  "fallback-grok-4.3": "Auto, an intelligent model router built by HackerAI",
  "title-generator-model": "Google Gemini 3 Flash",
};

export const getModelDisplayName = (modelName: ModelName): string => {
  return modelDisplayNames[modelName];
};

export const getModelCutoffDate = (modelName: ModelName): string => {
  return modelCutoffDates[modelName];
};

export function isAnthropicModel(modelName: string): boolean {
  return modelName.includes("sonnet") || modelName.includes("opus");
}

export function isDeepSeekModel(modelName: string): boolean {
  return (
    modelName === "ask-model-free" ||
    modelName === "agent-model-free" ||
    modelName === "model-deepseek-v4-flash" ||
    modelName === "model-deepseek-v4-pro"
  );
}

export function isKimiModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized === "agent-model" ||
    normalized === "model-kimi-k2.7-code" ||
    normalized === "model-kimi-k2.6" ||
    normalized.includes("moonshotai/kimi") ||
    normalized.includes("kimi-")
  );
}

export function supportsMultimodalToolResults(modelName?: string): boolean {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase();

  return (
    normalized === "ask-model" ||
    isKimiModel(normalized) ||
    normalized.includes("gemini") ||
    normalized.includes("google/") ||
    isAnthropicModel(normalized) ||
    normalized.includes("anthropic/") ||
    normalized.includes("claude") ||
    normalized.includes("openai/") ||
    normalized.includes("gpt-") ||
    normalized.includes("o1") ||
    normalized.includes("o3") ||
    normalized.includes("o4") ||
    normalized.includes("x-ai/") ||
    normalized.includes("grok")
  );
}

export function isGeminiModel(modelName: string): boolean {
  return modelName === "ask-model" || modelName === "model-gemini-3-flash";
}

/**
 * Map a HackerAI tier id to the underlying provider key for a given mode.
 * Returns `null` for `"auto"` (the caller routes to the auto-router model
 * key instead). Standard and Pro are mode-aware; Deep (`hackerai-max`) maps
 * to Opus in both modes.
 */
export function resolveTierToProviderKey(
  tier: SelectedModel,
  mode: ChatMode,
): ModelName | null {
  if (tier === "auto") return null;
  switch (tier) {
    case "hackerai-standard":
      return isAgentMode(mode)
        ? "model-kimi-k2.7-code"
        : "model-deepseek-v4-pro";
    case "hackerai-pro":
      return "model-sonnet-4.6";
    case "hackerai-max":
      return "model-opus-4.6";
  }
}

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = () =>
  // userId?: string,
  // conversationId?: string,
  // subscription?: SubscriptionTier,
  // phClient?: ReturnType<typeof PostHogClient> | null,
  {
    // PostHog provider tracking disabled
    // if (!phClient || subscription === "free") {
    //   return myProvider;
    // }
    //
    // const trackedModels: Record<string, any> = {};
    //
    // Object.entries(baseProviders).forEach(([modelName, model]) => {
    //   trackedModels[modelName] = withTracing(model, phClient, {
    //     ...(userId && { posthogDistinctId: userId }),
    //     posthogProperties: {
    //       modelType: modelName,
    //       ...(conversationId && { conversationId }),
    //       subscriptionTier: subscription,
    //     },
    //     posthogPrivacyMode: true,
    //   });
    // });
    //
    // return customProvider({
    //   languageModels: trackedModels,
    // });

    return myProvider;
  };
