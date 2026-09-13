import type { ChatMessage } from "@/types";

const getAgentLongPartProgressFingerprint = (part: unknown): string => {
  if (typeof part !== "object" || part === null) return String(part);

  const typedPart = part as {
    type?: unknown;
    text?: unknown;
    delta?: unknown;
    state?: unknown;
    toolCallId?: unknown;
    data?: {
      terminal?: unknown;
      toolCallId?: unknown;
    };
  };
  const type = typeof typedPart.type === "string" ? typedPart.type : "unknown";
  const textLength =
    typeof typedPart.text === "string" ? typedPart.text.length : undefined;
  const deltaLength =
    typeof typedPart.delta === "string" ? typedPart.delta.length : undefined;
  const terminalLength =
    typeof typedPart.data?.terminal === "string"
      ? typedPart.data.terminal.length
      : undefined;
  const toolCallId =
    typeof typedPart.toolCallId === "string"
      ? typedPart.toolCallId
      : typeof typedPart.data?.toolCallId === "string"
        ? typedPart.data.toolCallId
        : "";

  return `${type}:${typedPart.state ?? ""}:${toolCallId}:${textLength ?? 0}:${
    deltaLength ?? 0
  }:${terminalLength ?? 0}`;
};

/**
 * Tracks progress for the active Agent response without serializing the full
 * transcript or a potentially large tool result on every streamed part. Agent
 * progress is append-oriented, so the latest message id, part count, and a
 * shallow latest-part signature are sufficient to reset the completion
 * poller's quiet timer.
 */
export const getAgentLongMessageProgressFingerprint = (
  messages: ChatMessage[],
): string => {
  const latestMessage = messages.at(-1);
  if (!latestMessage) return "";

  const parts = latestMessage.parts ?? [];
  const latestPart = parts.at(-1);

  return `${latestMessage.id}:${latestMessage.role}:${parts.length}:${
    latestPart === undefined
      ? "empty"
      : getAgentLongPartProgressFingerprint(latestPart)
  }`;
};
