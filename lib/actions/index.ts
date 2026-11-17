import {
  APICallError,
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  UIMessage,
  UIMessageStreamWriter,
} from "ai";
import { myProvider } from "@/lib/ai/providers";
import { z } from "zod";
import {
  buildProviderOptions,
  isXaiSafetyError,
} from "@/lib/api/chat-stream-helpers";
import { getProviderUsageRawModelCost } from "@/lib/provider-usage-cost";
import { redactSensitiveErrorMessage } from "@/lib/utils/error-redaction";

const MAX_GENERATED_TITLE_LENGTH = 100;
const TITLE_GENERATION_MAX_OUTPUT_TOKENS = 64;
// Ask and Agent await the title before settling usage; a stalled provider
// must not hold the response open. Covers retries under one deadline.
const TITLE_GENERATION_TOTAL_TIMEOUT_MS = 8_000;
const FALLBACK_TITLE_WORD_LIMIT = 5;
const IMAGE_ONLY_CHAT_TITLE = "New chat";
const AUXILIARY_IMAGE_DESCRIPTION_PATTERN =
  /^<image_description\b(?=[^>]*\btrust="untrusted")[^>]*>[\s\S]*<\/image_description>$/;

/** Identify public failure classes without retaining error text, values or arbitrary names. */
const getUnknownTitleErrorKind = (
  error: unknown,
):
  | "sdk_no_output"
  | "sdk_type_validation"
  | "sdk_json_parse"
  | "js_type_error"
  | "js_range_error"
  | "js_syntax_error"
  | "other_error"
  | "non_error"
  | "unavailable" => {
  try {
    if (NoOutputGeneratedError.isInstance(error)) return "sdk_no_output";
    if (TypeValidationError.isInstance(error)) return "sdk_type_validation";
    if (JSONParseError.isInstance(error)) return "sdk_json_parse";
    if (error instanceof TypeError) return "js_type_error";
    if (error instanceof RangeError) return "js_range_error";
    if (error instanceof SyntaxError) return "js_syntax_error";
    return error instanceof Error ? "other_error" : "non_error";
  } catch {
    // A thrown value can reject brand inspection; diagnostics must preserve fallback.
    return "unavailable";
  }
};

/**
 * True when a UTF-16 cut at `index` would separate a valid surrogate pair.
 * Already-unpaired surrogates in the input are left as they are.
 */
const splitsSurrogatePair = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
};

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;

  const halfLength = Math.floor((maxLength - 3) / 2); // -3 for "..."
  // Shrink each kept edge rather than splitting an emoji, staying within budget.
  let headEnd = halfLength;
  if (splitsSurrogatePair(text, headEnd)) headEnd -= 1;
  let tailStart = text.length - halfLength;
  if (splitsSurrogatePair(text, tailStart)) tailStart += 1;

  return `${text.substring(0, headEnd)}...${text.substring(tailStart)}`;
};

const TITLE_QUOTES = new Set(['"', "'", "`"]);

/** Remove one quote pair only when it unambiguously wraps the whole title. */
const unwrapQuotedTitle = (title: string): string => {
  // Delimiters with no content are not a title; let the caller fall back.
  if (/^["'`\s]*$/.test(title)) return "";

  const quote = title[0];
  if (
    title.length < 2 ||
    !TITLE_QUOTES.has(quote) ||
    title[title.length - 1] !== quote
  ) {
    return title;
  }

  const inner = title.slice(1, -1);
  // `"foo" and "bar"` has matching ends but no single wrapper.
  return inner.includes(quote) ? title : inner;
};

/** Fold whitespace and apply the length limit to already-redacted text. */
const finishRedactedTitle = (title: string): string | undefined => {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  let end = MAX_GENERATED_TITLE_LENGTH;
  if (splitsSurrogatePair(normalized, end)) end -= 1;
  return normalized.substring(0, end);
};

const normalizeGeneratedTitle = (title: unknown): string | undefined => {
  if (typeof title !== "string") return undefined;
  // Unwrap first: an unquoted redacted value would absorb the closing quote.
  // Redact before folding or truncation can separate a value from its field.
  return finishRedactedTitle(
    redactSensitiveErrorMessage(unwrapQuotedTitle(title.trim())),
  );
};

const fallbackTitleFromRedactedMessage = (
  message: string,
): string | undefined => {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  return finishRedactedTitle(
    unwrapQuotedTitle(
      normalized.split(" ").slice(0, FALLBACK_TITLE_WORD_LIMIT).join(" "),
    ),
  );
};

const buildTitlePromptFromRedactedMessage = (message: string) => `### Task:
You are a helpful assistant that generates short, concise chat titles for an AI penetration testing assistant based on the first user message.

### Instructions:
1. Generate a short title (3-5 words) that accurately reflects the actual topic of the user's first message — whatever it is. Do NOT force a security/hacking framing onto unrelated topics (e.g., a question about cooking should get a cooking title, not a security one).
2. Generate the title in the SAME language as the user's first message (e.g., if the message is in Spanish, the title MUST be in Spanish; if in Russian, the title MUST be in Russian). Default to English only if the language cannot be determined.

### User Message:
${truncateMiddle(message, 8000)}`;

export const DEFAULT_TITLE_GENERATION_PROMPT_TEMPLATE = (message: string) =>
  buildTitlePromptFromRedactedMessage(redactSensitiveErrorMessage(message));

export const generateTitleFromUserMessage = async (
  truncatedMessages: UIMessage[],
  onCost?: (costDollars: number) => void,
): Promise<string | undefined> => {
  const firstMessage = truncatedMessages[0];
  const firstMessageParts = firstMessage?.parts ?? [];
  const isAuxiliaryImageDescription = (part: {
    type: string;
    text?: string;
  }): boolean =>
    part.type === "text" &&
    AUXILIARY_IMAGE_DESCRIPTION_PATTERN.test((part.text ?? "").trim());
  const textContent = firstMessageParts
    .filter(
      (part: { type: string; text?: string }) =>
        part.type === "text" && !isAuxiliaryImageDescription(part),
    )
    .map((part: { type: string; text?: string }) => part.text || "")
    .join(" ");
  const hasImage = firstMessageParts.some(
    (part) =>
      (part.type === "file" && part.mediaType.startsWith("image/")) ||
      isAuxiliaryImageDescription(part),
  );

  if (!textContent.trim() && hasImage) {
    return IMAGE_ONLY_CHAT_TITLE;
  }

  // Remove credentials the shared redactor recognizes (not every possible
  // secret) once, before the prompt and fallback truncate the text.
  const redactedText = redactSensitiveErrorMessage(textContent);
  const fallbackTitle = fallbackTitleFromRedactedMessage(redactedText);

  try {
    const result = await generateText({
      model: myProvider.languageModel("title-generator-model"),
      providerOptions: buildProviderOptions(
        false,
        undefined,
        "title-generator-model",
        "ask",
      ),
      output: Output.object({
        schema: z.object({
          title: z
            .string()
            .trim()
            .min(1)
            .max(MAX_GENERATED_TITLE_LENGTH)
            .describe(
              "A concise chat title, 3-5 words, in the same language as the user message",
            ),
        }),
      }),
      temperature: 0,
      maxOutputTokens: TITLE_GENERATION_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      timeout: { totalMs: TITLE_GENERATION_TOTAL_TIMEOUT_MS },
      messages: [
        {
          role: "user",
          content: buildTitlePromptFromRedactedMessage(redactedText),
        },
      ],
    });

    const costDollars = getProviderUsageRawModelCost(result.usage?.raw);
    if (costDollars !== undefined) {
      onCost?.(costDollars);
    }

    return normalizeGeneratedTitle(result.output?.title) ?? fallbackTitle;
  } catch (error) {
    // SDK errors can contain prompts, provider responses, and credentials.
    // Keep fallback diagnostics limited to fixed categories/kinds and HTTP status.
    const isProviderError = APICallError.isInstance(error);
    const category = isProviderError
      ? "provider_error"
      : NoObjectGeneratedError.isInstance(error)
        ? "invalid_output"
        : "unknown_error";
    console.warn("chat_title_generation_failed", {
      category,
      ...(isProviderError && { statusCode: error.statusCode }),
      error_kind_version: 1,
      error_kind:
        category === "provider_error"
          ? "provider_api_error"
          : category === "invalid_output"
            ? "sdk_no_object"
            : getUnknownTitleErrorKind(error),
    });
    return fallbackTitle;
  }
};

export const generateTitleFromUserMessageWithWriter = async (
  truncatedMessages: UIMessage[],
  writer: UIMessageStreamWriter,
  onTitleGenerated?: (title: string) => Promise<unknown>,
  onCost?: (costDollars: number) => void,
): Promise<string | undefined> => {
  try {
    const chatTitle = await generateTitleFromUserMessage(
      truncatedMessages,
      onCost,
    );

    writer.write({
      type: "data-title",
      data: { chatTitle },
      transient: true,
    });

    if (chatTitle && onTitleGenerated) {
      try {
        await onTitleGenerated(chatTitle);
      } catch (error) {
        console.error("Failed to persist generated chat title:", error);
      }
    }

    return chatTitle;
  } catch (error) {
    // Log error but don't propagate to keep main stream resilient
    // Suppress xAI safety check errors (expected for certain content)
    if (!isXaiSafetyError(error)) {
      console.error("Failed to generate or write chat title:", error);
    }
    return undefined;
  }
};
