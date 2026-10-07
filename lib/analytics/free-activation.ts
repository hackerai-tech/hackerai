import type { UIMessage } from "ai";

/** Inspect only the completed reply, never count old history or tool-only turns. */
export function hasCompletedAssistantText(
  messages: UIMessage[],
  messageId: string,
): boolean {
  return messages.some(
    (message) =>
      message.id === messageId &&
      message.role === "assistant" &&
      message.parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      ),
  );
}
