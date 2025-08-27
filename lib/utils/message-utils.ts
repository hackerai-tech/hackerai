/**
 * Utility functions for processing message parts
 */

export interface MessagePart {
  type: string;
  text?: string;
}

/**
 * Extracts text content from message parts
 */
export const extractMessageText = (parts: MessagePart[]): string => {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("");
};

/**
 * Checks if message parts contain any text content
 */
export const hasTextContent = (parts: MessagePart[]): boolean => {
  return parts.some(
    (part) =>
      (part.type === "text" && part.text && part.text.trim() !== "") ||
      part.type === "step-start" ||
      part.type.startsWith("tool-"),
  );
};

/**
 * Finds the index of the last assistant message
 */
export const findLastAssistantMessageIndex = (
  messages: Array<{ role: string }>,
): number | undefined => {
  return messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;
};
