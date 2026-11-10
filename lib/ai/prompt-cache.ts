import { isAbliterationModel } from "./abliteration";
import { isInferenceCyberModel } from "./inference";
import type { ModelMessage } from "ai";

type PromptCacheOptions = {
  openrouter?: {
    session_id?: string;
  };
  abliteration?: { prompt_cache_key: string };
};

/** Cache hints only: never change model, reasoning, fallback, or privacy policy. */
export function buildPromptCacheOptions(
  requestedModelSlug: string,
  sessionId?: string,
): PromptCacheOptions {
  // No verified cache-affinity option for the direct Inference adapter.
  // In particular, never leak OpenRouter routing hints to this endpoint.
  if (isInferenceCyberModel(requestedModelSlug)) return {};
  if (isAbliterationModel(requestedModelSlug)) {
    return sessionId ? { abliteration: { prompt_cache_key: sessionId } } : {};
  }

  return {
    openrouter: {
      ...(sessionId && { session_id: sessionId }),
    },
  };
}

/** Keep the user anchor and advance one breakpoint through completed tool work. */
export function addPromptCacheBreakpoints(
  messages: ModelMessage[],
  requestedModelSlug: string,
): ModelMessage[] {
  if (!requestedModelSlug.startsWith("anthropic/")) return messages;
  const marker = { cacheControl: { type: "ephemeral" } };
  // Re-decoration must not retain old rolling markers from a prior request.
  // Only cache hints are removed; reasoning signatures and all other metadata
  // survive. Copy on write, including part options, leaves saved history intact.
  const clearOptions = (options: ModelMessage["providerOptions"]) => {
    if (!options) return options;
    let result = options;
    for (const namespace of ["openrouter", "anthropic"]) {
      const entry = options[namespace];
      if (!entry || !("cacheControl" in entry || "cache_control" in entry))
        continue;
      const cleaned = { ...entry };
      delete cleaned.cacheControl;
      delete cleaned.cache_control;
      result = { ...result, [namespace]: cleaned };
    }
    return result;
  };
  const result = messages.map((message) => ({
    ...message,
    ...(message.providerOptions && {
      providerOptions: clearOptions(message.providerOptions),
    }),
    ...(Array.isArray(message.content) && {
      content: message.content.map((part) =>
        "providerOptions" in part && part.providerOptions
          ? { ...part, providerOptions: clearOptions(part.providerOptions) }
          : part,
      ),
    }),
  })) as ModelMessage[];
  const userIndex = result.findLastIndex((message) => message.role === "user");
  if (userIndex >= 0) {
    const message = result[userIndex];
    result[userIndex] = {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        openrouter: { ...message.providerOptions?.openrouter, ...marker },
      },
    };
  }
  const last = result.at(-1);
  if (last?.role === "tool") {
    // Message-level options are copied to EVERY tool result by the SDK. Mark
    // just one result so parallel calls cannot exceed Anthropic's four slots.
    const index = last.content.findLastIndex(
      (part) => part.type === "tool-result",
    );
    if (index >= 0 && last.content[index].type === "tool-result") {
      const content = [...last.content];
      const part = last.content[index];
      content[index] = {
        ...part,
        providerOptions: {
          ...part.providerOptions,
          openrouter: { ...part.providerOptions?.openrouter, ...marker },
        },
      };
      result[result.length - 1] = { ...last, content };
    }
  }
  return result;
}
