import type { UIMessage } from "ai";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  getProviderStatusCode,
} from "@/lib/utils/error-utils";

const TOOL_FILE_PART_TYPE = "tool-file";

const IMAGE_TOOL_RESULT_OMITTED_TEXT =
  "[Image view omitted because the model provider rejected image tool output. Continue without visual inspection. Use text extraction, browser snapshot refs, or ask the user to switch to a vision-capable model if visual inspection is required.]";

type ImageViewOutput = {
  action?: unknown;
  kind?: unknown;
  mediaType?: unknown;
  imageOmittedAfterProviderRejection?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isImageViewToolOutput = (
  output: unknown,
): output is Record<string, unknown> & ImageViewOutput => {
  if (!isRecord(output)) return false;
  return (
    output.action === "view" &&
    output.kind === "image" &&
    typeof output.mediaType === "string" &&
    output.mediaType.startsWith("image/") &&
    output.imageOmittedAfterProviderRejection !== true
  );
};

export const uiMessagesContainImageViewResult = (
  messages: UIMessage[],
): boolean =>
  messages.some((message) =>
    message.parts?.some((part) => {
      if (!isRecord(part) || part.type !== TOOL_FILE_PART_TYPE) return false;
      return isImageViewToolOutput(part.output);
    }),
  );

export const toolResultsContainImageViewResult = (
  toolResults: unknown[],
): boolean =>
  toolResults.some((toolResult) => {
    if (!isRecord(toolResult) || toolResult.toolName !== "file") return false;
    return isImageViewToolOutput(toolResult.output);
  });

export function omitImageViewToolResultsForProviderRetry(
  messages: UIMessage[],
): { messages: UIMessage[]; omittedCount: number } {
  let omittedCount = 0;

  const nextMessages = messages.map((message) => {
    let changed = false;
    const parts = message.parts?.map((part) => {
      if (!isRecord(part) || part.type !== TOOL_FILE_PART_TYPE) return part;
      if (!isImageViewToolOutput(part.output)) return part;

      omittedCount++;
      changed = true;
      const output = part.output;

      return {
        ...part,
        output: {
          ...output,
          error: IMAGE_TOOL_RESULT_OMITTED_TEXT,
          content: IMAGE_TOOL_RESULT_OMITTED_TEXT,
          previewFiles: undefined,
          data: undefined,
          imageOmittedAfterProviderRejection: true,
        },
      };
    });

    return changed ? ({ ...message, parts } as UIMessage) : message;
  });

  return {
    messages: omittedCount > 0 ? nextMessages : messages,
    omittedCount,
  };
}

export const omitTrailingStepStartAssistantMessage = (
  messages: UIMessage[],
): UIMessage[] => {
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role !== "assistant" ||
    lastMessage.parts?.length !== 1 ||
    lastMessage.parts[0]?.type !== "step-start"
  ) {
    return messages;
  }

  return messages.slice(0, -1);
};

const MULTIMODAL_REJECTION_PATTERNS = [
  /image[-_\s]?data/i,
  /input[_\s-]?image/i,
  /image(?:\s+content|\s+input|\s+part|\s+block|\s+tool|\s+output)/i,
  /(?:vision|multimodal).{0,80}(?:not supported|unsupported|reject|invalid|disabled|unavailable)/i,
  /(?:not supported|unsupported|reject|invalid).{0,80}(?:vision|multimodal|image)/i,
  /model does not support images/i,
  /image.*(?:must be|should be).*(?:url|text)/i,
  /fetching image from URL/i,
  /content.*image.*not.*allowed/i,
] as const;

const MEDIA_OVERFLOW_PATTERN =
  /image(?: file)? too large|media(?: file)? too large|base64.*too large/i;

const detailsToSearchText = (details: Record<string, unknown>): string =>
  [
    details.errorMessage,
    details.providerErrorMessage,
    details.providerRawError,
    details.cause,
    details.responseBody,
    details.errorCode,
    details.providerErrorCode,
  ]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");

export const isProviderMultimodalToolResultRejectionError = (
  error: unknown,
): boolean => {
  const details = extractErrorDetails(error);
  const category = getProviderErrorCategory(details);
  const statusCode = getProviderStatusCode(details);

  if (
    category !== "provider_4xx" &&
    category !== "unknown" &&
    category !== "stream_terminated"
  ) {
    return false;
  }

  if (
    statusCode != null &&
    statusCode !== 400 &&
    statusCode !== 404 &&
    statusCode !== 422
  ) {
    return false;
  }

  const text = detailsToSearchText(details);
  if (!text || MEDIA_OVERFLOW_PATTERN.test(text)) return false;

  return MULTIMODAL_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
};

export const getImageToolResultOmittedText = () =>
  IMAGE_TOOL_RESULT_OMITTED_TEXT;
