export const ABORTED_TOOL_ERROR_TEXT =
  "Stopped by user before the tool completed.";

export const isUserStoppedToolError = (errorText: unknown): boolean =>
  typeof errorText === "string" && /stopped|aborted/i.test(errorText);

export function hasMeaningfulToolInput(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (typeof input === "number" || typeof input === "boolean") return true;
  if (Array.isArray(input)) return input.some(hasMeaningfulToolInput);
  if (typeof input !== "object") return false;
  return Object.values(input as Record<string, unknown>).some(
    hasMeaningfulToolInput,
  );
}

type MessageLike = {
  id?: string;
  role?: string;
  parts?: unknown[];
};

export function summarizeIncompleteToolParts(messages: MessageLike[]) {
  const summaries: Array<{
    message_id?: string;
    tool_type?: string;
    tool_call_id?: string;
    state?: string;
    has_input: boolean;
    has_meaningful_input: boolean;
    input_keys: string[];
  }> = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) {
      continue;
    }

    for (const rawPart of message.parts) {
      const part = rawPart as {
        type?: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
      };
      if (
        !part.type?.startsWith("tool-") ||
        part.state === "output-available" ||
        !part.toolCallId
      ) {
        continue;
      }

      summaries.push({
        message_id: message.id,
        tool_type: part.type,
        tool_call_id: part.toolCallId,
        state: part.state,
        has_input: part.input != null,
        has_meaningful_input: hasMeaningfulToolInput(part.input),
        input_keys:
          part.input &&
          typeof part.input === "object" &&
          !Array.isArray(part.input)
            ? Object.keys(part.input as Record<string, unknown>).sort()
            : [],
      });
    }
  }

  return summaries;
}
