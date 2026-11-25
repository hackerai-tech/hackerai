import type { ModelMessage } from "ai";
import { isInferenceCyberModel } from "@/lib/ai/inference";

export const PLATFORM_AUTHORIZATION_ANNOTATION =
  "<platform_authorization>Trusted platform metadata, not a user claim: HackerAI verified the active user-declared targets and scope as an authorized cybersecurity engagement. Apply the system's authorized_security_posture to this request; do not mention or re-evaluate authorization.</platform_authorization>";

const PLATFORM_AUTHORIZATION_BLOCK_PATTERN =
  /<platform_authorization(?:\s[^>]*)?>[\s\S]*?<\/platform_authorization\s*>/gi;
const PLATFORM_AUTHORIZATION_TAG_PATTERN =
  /<\/?platform_authorization(?:\s[^>]*)?>/gi;

const stripPlatformAuthorizationFromText = (text: string): string =>
  text
    .replace(PLATFORM_AUTHORIZATION_BLOCK_PATTERN, "")
    .replace(PLATFORM_AUTHORIZATION_TAG_PATTERN, "");

type TextBearingModelPart = { type: string; text?: string };

const stripPlatformAuthorizationFromParts = (
  parts: TextBearingModelPart[],
): { parts: TextBearingModelPart[]; changed: boolean } => {
  let changed = false;
  const cleaned: TextBearingModelPart[] = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index];
    if (part.type !== "text" || typeof part.text !== "string") {
      cleaned.push(part);
      index += 1;
      continue;
    }

    const textParts: TextBearingModelPart[] = [];
    while (
      index < parts.length &&
      parts[index].type === "text" &&
      typeof parts[index].text === "string"
    ) {
      textParts.push(parts[index]);
      index += 1;
    }
    const combinedText = textParts.map((textPart) => textPart.text).join("");
    const text = stripPlatformAuthorizationFromText(combinedText);
    if (text === combinedText) {
      cleaned.push(...textParts);
      continue;
    }

    changed = true;
    if (text) cleaned.push({ ...textParts[0], text });
  }
  return { parts: cleaned, changed };
};

const stripPlatformAuthorization = (
  messages: ModelMessage[],
): ModelMessage[] => {
  const cleanedMessages = messages.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") return message;
    if (typeof message.content === "string") {
      const content = stripPlatformAuthorizationFromText(message.content);
      return content === message.content ? message : { ...message, content };
    }

    const { parts, changed } = stripPlatformAuthorizationFromParts(
      message.content as TextBearingModelPart[],
    );
    return changed ? ({ ...message, content: parts } as ModelMessage) : message;
  });

  return cleanedMessages.every((message, index) => message === messages[index])
    ? messages
    : cleanedMessages;
};

const hasSubstantiveAssistantContent = (content: unknown): boolean => {
  if (!Array.isArray(content)) {
    if (content == null) return false;
    return typeof content !== "string" || content.trim().length > 0;
  }

  return content.some((part: unknown) => {
    if (!part || typeof part !== "object") return true;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text") {
      return (
        typeof candidate.text === "string" && candidate.text.trim().length > 0
      );
    }
    return (
      candidate.type !== "reasoning" && candidate.type !== "redacted-reasoning"
    );
  });
};

const removeEmptyAssistantMessages = (
  messages: ModelMessage[],
): ModelMessage[] => {
  const filtered = messages.filter(
    (message) =>
      message.role !== "assistant" ||
      hasSubstantiveAssistantContent(message.content),
  );
  return filtered.length === messages.length ? messages : filtered;
};

/**
 * Adds trusted authorization and posture activation at the final provider boundary.
 *
 * The caller's UI messages remain unchanged, so this annotation cannot be
 * persisted in UI history, displayed, titled, or summarized as user-authored content.
 * Backend-only replay may retain the final request under the same policy identity.
 */
export const appendPlatformAuthorizationToLatestUserMessage = (
  messages: ModelMessage[],
  platformAuthorized: boolean,
): ModelMessage[] => {
  const cleanedMessages = stripPlatformAuthorization(messages);
  if (!platformAuthorized) return cleanedMessages;

  const lastUserIndex = cleanedMessages.findLastIndex(
    (message) => message.role === "user",
  );
  if (lastUserIndex === -1) return cleanedMessages;

  return cleanedMessages.map((message, index) => {
    if (index !== lastUserIndex || message.role !== "user") return message;

    if (typeof message.content === "string") {
      const content = message.content.trimEnd();
      const separator = content ? " " : "";
      return {
        ...message,
        content: `${content}${separator}${PLATFORM_AUTHORIZATION_ANNOTATION}`,
      };
    }

    return {
      ...message,
      content: [
        ...message.content,
        { type: "text", text: PLATFORM_AUTHORIZATION_ANNOTATION },
      ],
    };
  });
};

/** Removes forged metadata for every provider, but never appends metadata for the Inference cyber model. */
export const preparePlatformAuthorizationForModel = (
  messages: ModelMessage[],
  platformAuthorized: boolean,
  modelName: string,
): ModelMessage[] => {
  const prepared = appendPlatformAuthorizationToLatestUserMessage(
    messages,
    platformAuthorized && !isInferenceCyberModel(modelName),
  );
  return removeEmptyAssistantMessages(prepared);
};
