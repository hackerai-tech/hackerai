/**
 * Converts UIMessage[] into a human-readable plain-text transcript.
 *
 * Output format:
 *   user:
 *   <user_query>...</user_query>
 *
 *   A:
 *   [Tool call] toolName
 *     key: value
 *   [Tool result] toolName
 *   [Thinking] ...reasoning text...
 *   [File: filename]
 *   [Source: url]
 *   ...response text...
 *
 * Transient/data parts (data-terminal, data-python, data-diff, data-summarization,
 * step-start) are skipped.
 */
import type { UIMessage } from "ai";

const TOOL_TYPE_PREFIX = "tool-";

const formatToolInput = (input: unknown): string => {
  if (input == null) return "";

  if (typeof input !== "object") return `  ${String(input)}`;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const val =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    lines.push(`  ${key}: ${val}`);
  }
  return lines.join("\n");
};

const formatToolOutput = (output: unknown): string => {
  if (output == null) return "";

  if (typeof output === "string") return output;

  return JSON.stringify(output, null, 2);
};

const extractToolName = (partType: string): string =>
  partType.startsWith(TOOL_TYPE_PREFIX)
    ? partType.slice(TOOL_TYPE_PREFIX.length)
    : partType;

const formatMessageParts = (message: UIMessage): string => {
  const sections: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      const textPart = part as { type: "text"; text: string };
      if (!textPart.text) continue;

      if (message.role === "user") {
        sections.push(`<user_query>\n${textPart.text}\n</user_query>`);
      } else {
        sections.push(textPart.text);
      }
      continue;
    }

    if (part.type.startsWith(TOOL_TYPE_PREFIX)) {
      const toolPart = part as {
        type: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
        output?: unknown;
      };
      const toolName = extractToolName(part.type);

      // Tool still pending -- only input available so far
      if (
        toolPart.state === "input-available" ||
        toolPart.state === "input-streaming"
      ) {
        const inputStr = formatToolInput(toolPart.input);
        sections.push(
          inputStr
            ? `[Tool call] ${toolName}\n${inputStr}`
            : `[Tool call] ${toolName}`,
        );
      }

      // Tool completed -- emit both call + result together
      if (
        toolPart.state === "output-available" ||
        toolPart.state === "output-error"
      ) {
        const inputStr = formatToolInput(toolPart.input);
        if (inputStr) {
          sections.push(`[Tool call] ${toolName}\n${inputStr}`);
        }

        const outputStr = formatToolOutput(toolPart.output);
        sections.push(
          outputStr
            ? `[Tool result] ${toolName}\n${outputStr}`
            : `[Tool result] ${toolName}`,
        );
      }
      continue;
    }

    if (part.type === "reasoning") {
      const reasoningPart = part as { type: "reasoning"; text: string };
      if (reasoningPart.text) {
        sections.push(`[Thinking] ${reasoningPart.text}`);
      }
      continue;
    }

    if (part.type === "file") {
      const filePart = part as { type: "file"; filename?: string };
      sections.push(
        filePart.filename ? `[File: ${filePart.filename}]` : "[File]",
      );
      continue;
    }

    if (part.type === "source-url" || part.type === "source-document") {
      const sourcePart = part as { type: string; url?: string; title?: string };
      if (sourcePart.url) {
        sections.push(`[Source: ${sourcePart.url}]`);
      }
      continue;
    }

    // Skip transient/data parts (data-terminal, data-python, data-diff, data-summarization, step-start)
  }

  return sections.join("\n\n");
};

export const formatTranscript = (messages: UIMessage[]): string => {
  const blocks: string[] = [];

  for (const message of messages) {
    const roleLabel = message.role === "user" ? "user:" : "A:";
    const content = formatMessageParts(message);

    if (!content) continue;

    blocks.push(`${roleLabel}\n${content}`);
  }

  return blocks.join("\n\n");
};
