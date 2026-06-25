import type { ModelMessage } from "ai";

export const PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES = 450_000;
export const PROVIDER_PRESSURE_TOOL_RESULT_COUNT = 100;
export const PROVIDER_PRESSURE_MESSAGE_COUNT = 120;
export const PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS = 128_000;

export type ProviderPromptPressureReason =
  | "serialized_message_bytes"
  | "tool_result_count"
  | "message_count";

export interface ProviderPromptPressure {
  reason: ProviderPromptPressureReason;
  reasons: ProviderPromptPressureReason[];
  serializedMessageBytes?: number;
  toolResultCount: number;
  messageCount: number;
  summarizationMaxTokensOverride: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isImageMediaType = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().startsWith("image/");

const isPdfMediaType = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase() === "application/pdf";

const isImageDataUrl = (value: unknown): boolean =>
  typeof value === "string" && /^data:image\//i.test(value);

const isPdfDataUrl = (value: unknown): boolean =>
  typeof value === "string" && /^data:application\/pdf[;,]/i.test(value);

const isInlineMediaDataUrl = (value: unknown): boolean =>
  isImageDataUrl(value) || isPdfDataUrl(value);

const isImageLikeRecord = (value: Record<string, unknown>): boolean =>
  value.type === "image" ||
  value.type === "image-data" ||
  value.kind === "image" ||
  isImageMediaType(value.mediaType) ||
  isImageMediaType(value.mimeType) ||
  isImageMediaType(value.mime);

const isPdfLikeRecord = (value: Record<string, unknown>): boolean =>
  isPdfMediaType(value.mediaType) ||
  isPdfMediaType(value.mimeType) ||
  isPdfMediaType(value.mime);

const compactInlineMediaPayload = (value: unknown): string => {
  if (typeof value === "string") {
    return `[inline media data omitted: ${value.length} chars]`;
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `[inline media data omitted: ${value.byteLength} bytes]`;
  }

  return "[inline media data omitted]";
};

const sanitizeForSerializedByteEstimate = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sanitizeForSerializedByteEstimate);
  }

  if (!isRecord(value)) {
    return value;
  }

  const inlineMediaLike = isImageLikeRecord(value) || isPdfLikeRecord(value);
  const sanitized: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (
      (inlineMediaLike && (key === "data" || key === "image")) ||
      ((key === "data" || key === "image" || key === "url") &&
        isInlineMediaDataUrl(childValue))
    ) {
      sanitized[key] = compactInlineMediaPayload(childValue);
      continue;
    }

    sanitized[key] = sanitizeForSerializedByteEstimate(childValue);
  }

  return sanitized;
};

const getSerializedBytes = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(
      JSON.stringify(sanitizeForSerializedByteEstimate(value)),
    ).length;
  } catch {
    return undefined;
  }
};

const countToolResultParts = (messages: ModelMessage[]): number => {
  let count = 0;

  for (const message of messages) {
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (isRecord(part) && part.type === "tool-result") {
        count++;
      }
    }
  }

  return count;
};

export const getProviderPromptPressure = (
  messages: ModelMessage[],
): ProviderPromptPressure | null => {
  const serializedMessageBytes = getSerializedBytes(messages);
  const toolResultCount = countToolResultParts(messages);
  const messageCount = messages.length;
  const reasons: ProviderPromptPressureReason[] = [];

  if (
    serializedMessageBytes != null &&
    serializedMessageBytes >= PROVIDER_PRESSURE_SERIALIZED_MESSAGE_BYTES
  ) {
    reasons.push("serialized_message_bytes");
  }

  if (toolResultCount >= PROVIDER_PRESSURE_TOOL_RESULT_COUNT) {
    reasons.push("tool_result_count");
  }

  if (messageCount >= PROVIDER_PRESSURE_MESSAGE_COUNT) {
    reasons.push("message_count");
  }

  if (reasons.length === 0) return null;

  return {
    reason: reasons[0],
    reasons,
    serializedMessageBytes,
    toolResultCount,
    messageCount,
    summarizationMaxTokensOverride: PROVIDER_PRESSURE_SUMMARIZATION_MAX_TOKENS,
  };
};
