import type { ChatMessage } from "@/types/chat";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";

/**
 * Serializes a message part into a human-readable text representation.
 */
function serializePart(part: any): string {
  switch (part.type) {
    case "text":
      return part.text || "";

    case "file":
      return `[File: ${part.name || part.filename || "attachment"}${part.mediaType ? ` (${part.mediaType})` : ""}]`;

    case "reasoning":
    case "step-start":
      // Skip reasoning and step markers
      return "";

    default: {
      // Tool call parts (tool-*, codex_*)
      if (part.type?.startsWith("tool-") || part.type?.startsWith("codex_")) {
        return serializeToolPart(part);
      }
      // Unknown part type — skip
      return "";
    }
  }
}

/**
 * Serializes a tool call part (both server and codex tool calls).
 */
function serializeToolPart(part: any): string {
  const toolName =
    part.toolName ||
    part.type?.replace(/^tool-/, "").replace(/^codex_/, "") ||
    "unknown";
  const input = part.input;
  const output = part.output ?? part.result;

  const lines: string[] = [];

  // Format input
  if (input) {
    if (typeof input === "object") {
      // Codex-specific fields
      if (input.command) {
        lines.push(`[Tool: ${toolName}] command: \`${input.command}\``);
      } else if (input.path || input.filename) {
        const action = input.action || input.codexItemType || "operation";
        lines.push(
          `[Tool: ${toolName}] ${action}: ${input.path || input.filename}`,
        );
      } else if (input.query) {
        lines.push(`[Tool: ${toolName}] query: "${input.query}"`);
      } else {
        // Generic tool input
        const summary = summarizeObject(input);
        lines.push(`[Tool: ${toolName}] ${summary}`);
      }
    } else {
      lines.push(`[Tool: ${toolName}] ${String(input)}`);
    }
  } else {
    lines.push(`[Tool: ${toolName}]`);
  }

  // Format output
  if (output) {
    if (typeof output === "object") {
      if (output.output) {
        lines.push(`→ ${truncateString(String(output.output), 500)}`);
      } else if (output.result?.stdout) {
        lines.push(`→ ${truncateString(output.result.stdout, 500)}`);
      } else if (output.diff) {
        lines.push(`→ diff: ${truncateString(output.diff, 500)}`);
      } else {
        const summary = summarizeObject(output);
        lines.push(`→ ${truncateString(summary, 500)}`);
      }
    } else {
      lines.push(`→ ${truncateString(String(output), 500)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Creates a brief summary of an object for serialization.
 */
function summarizeObject(obj: any): string {
  try {
    const str = JSON.stringify(obj);
    return truncateString(str, 300);
  } catch {
    return "[complex object]";
  }
}

/**
 * Truncates a string to a maximum length with ellipsis.
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "...";
}

/**
 * Serializes a single message into text format.
 */
function serializeMessage(message: ChatMessage): string {
  const role = message.role === "user" ? "[User]" : "[Assistant]";
  const parts = (message.parts || [])
    .map(serializePart)
    .filter((s) => s.length > 0);

  if (parts.length === 0) return "";
  return `${role}: ${parts.join("\n")}`;
}

/**
 * Serializes conversation messages into a structured text block suitable for
 * injection into Codex developerInstructions.
 *
 * Truncates to maxTokens by keeping the most recent messages (using
 * truncateMessagesToTokenLimit from token-utils).
 */
export function serializeConversation(
  messages: ChatMessage[],
  maxTokens: number,
): string {
  // Filter to user and assistant messages only
  const relevantMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  if (relevantMessages.length === 0) return "";

  // Truncate to token limit, keeping most recent messages
  const truncatedMessages = truncateMessagesToTokenLimit(
    relevantMessages,
    {},
    maxTokens,
  );

  // If even the most recent message exceeds the token limit, nothing to inject
  if (truncatedMessages.length === 0) return "";

  const wasTruncated = truncatedMessages.length < relevantMessages.length;

  const serializedMessages = (truncatedMessages as ChatMessage[])
    .map(serializeMessage)
    .filter((s) => s.length > 0)
    .join("\n\n");

  const truncationNote = wasTruncated
    ? "[Earlier messages omitted for context limit]\n\n"
    : "";

  return `<prior_conversation>
The following is the conversation history from a prior AI model. Continue naturally from where it left off.

${truncationNote}${serializedMessages}
</prior_conversation>`;
}
