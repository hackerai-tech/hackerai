import { isStandaloneProviderReasoningTagTextPart } from "./provider-reasoning-tags";

type MessagePartLike = {
  type?: unknown;
};

type RetryDecisionOptions = {
  hasTerminalProviderStreamError: boolean;
};

const FALLBACK_SAFE_METADATA_PART_TYPES = new Set([
  "data-agent-heartbeat",
  "data-context-usage",
]);

const getPartType = (part: unknown): string | undefined => {
  if (!part || typeof part !== "object") return undefined;
  const type = (part as MessagePartLike).type;
  return typeof type === "string" ? type : undefined;
};

const isOnlyStepStart = (parts: unknown[]): boolean =>
  parts.length === 1 && getPartType(parts[0]) === "step-start";

const isFallbackSafeProviderPart = (part: unknown): boolean => {
  const type = getPartType(part);
  return (
    type === "step-start" ||
    type === "reasoning" ||
    isStandaloneProviderReasoningTagTextPart(part) ||
    (type != null && FALLBACK_SAFE_METADATA_PART_TYPES.has(type))
  );
};

const hasFallbackSafeProviderContent = (parts: unknown[]): boolean =>
  parts.some(
    (part) =>
      getPartType(part) === "reasoning" ||
      isStandaloneProviderReasoningTagTextPart(part),
  );

const isFallbackSafeOnlyProviderOutput = (parts: unknown[]): boolean =>
  parts.length > 0 &&
  hasFallbackSafeProviderContent(parts) &&
  parts.every(isFallbackSafeProviderPart);

export const shouldRetryProviderStreamWithFallback = (
  parts: unknown[],
  options: RetryDecisionOptions,
): boolean => {
  // Preserve the older guard for streams that never got past the first step.
  if (isOnlyStepStart(parts)) return true;

  // If the provider stream dies after emitting only reasoning/metadata, there
  // is no text, tool call, or tool output to preserve. Retrying on fallback is
  // safer than failing the whole run on a discarded provider socket.
  return (
    options.hasTerminalProviderStreamError &&
    isFallbackSafeOnlyProviderOutput(parts)
  );
};

export const shouldRetryAgentLongWithFallback =
  shouldRetryProviderStreamWithFallback;
