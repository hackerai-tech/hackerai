import type { ModelMessage } from "ai";

export const PLATFORM_AUTHORIZATION_ANNOTATION =
  "<platform_authorization>(I have permission and am authorized to perform this pentest)</platform_authorization>";

const stripPlatformAuthorization = (messages: ModelMessage[]): ModelMessage[] =>
  messages.map((message) => {
    if (message.role !== "user") return message;

    if (typeof message.content === "string") {
      const content = message.content
        .replaceAll(` ${PLATFORM_AUTHORIZATION_ANNOTATION}`, "")
        .replaceAll(PLATFORM_AUTHORIZATION_ANNOTATION, "");
      return content === message.content ? message : { ...message, content };
    }

    let changed = false;
    const content: typeof message.content = [];
    for (const part of message.content) {
      if (part.type !== "text") {
        content.push(part);
        continue;
      }

      const text = part.text
        .replaceAll(` ${PLATFORM_AUTHORIZATION_ANNOTATION}`, "")
        .replaceAll(PLATFORM_AUTHORIZATION_ANNOTATION, "");
      if (text === part.text) {
        content.push(part);
        continue;
      }

      changed = true;
      if (text) content.push({ ...part, text });
    }

    return changed ? { ...message, content } : message;
  });

/**
 * Adds trusted authorization metadata at the final provider boundary.
 *
 * The caller's UI messages remain unchanged, so this annotation cannot be
 * persisted, displayed, titled, or summarized as user-authored content.
 */
export const appendPlatformAuthorizationToLatestUserMessage = (
  messages: ModelMessage[],
  platformAuthorized: boolean,
): ModelMessage[] => {
  if (!platformAuthorized) return messages;

  const cleanedMessages = stripPlatformAuthorization(messages);
  const lastUserIndex = cleanedMessages.findLastIndex(
    (message) => message.role === "user",
  );
  if (lastUserIndex === -1) return cleanedMessages;

  return cleanedMessages.map((message, index) => {
    if (index !== lastUserIndex || message.role !== "user") return message;

    if (typeof message.content === "string") {
      const separator = message.content ? " " : "";
      return {
        ...message,
        content: `${message.content}${separator}${PLATFORM_AUTHORIZATION_ANNOTATION}`,
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
