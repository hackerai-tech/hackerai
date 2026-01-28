import { ChatMessage } from "@/types/chat";

/**
 * Strips provider-specific fields from a single message part.
 * Removes providerMetadata, callProviderMetadata, providerExecuted, and providerOptions.
 */
export const stripProviderMetadataFromPart = <T extends Record<string, any>>(
  part: T,
): T => {
  const {
    providerMetadata,
    callProviderMetadata,
    providerExecuted,
    providerOptions,
    ...rest
  } = part;
  return rest as T;
};

/**
 * Checks if a part is a completed reasoning block with redacted text.
 * These should be filtered out entirely as they provide no value when saved.
 */
const isRedactedReasoningPart = (part: Record<string, any>): boolean => {
  return (
    part.type === "reasoning" &&
    part.state === "done" &&
    part.text === "[REDACTED]"
  );
};

/**
 * Strips OpenRouter providerMetadata and callProviderMetadata from all parts in a message.
 * Also filters out completed reasoning blocks with redacted text.
 * Used to clean messages before saving or for temporary chat handling.
 *
 * NOTE: We intentionally preserve top-level reasoning/reasoning_details fields
 * because Gemini 3 models require thought signatures to be passed back in
 * subsequent requests for function calling to work correctly.
 */
export const stripProviderMetadata = <T extends { parts?: any[] }>(
  message: T,
): T => {
  if (!message.parts) return message;
  return {
    ...message,
    parts: message.parts
      .filter((part) => !isRedactedReasoningPart(part))
      .map(stripProviderMetadataFromPart),
  };
};

// Generic interface for all tool parts
interface BaseToolPart {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "result";
  input?: any;
  output?: any;
  result?: any;
}

// Specific interface for terminal tools that have special data handling
interface TerminalToolPart extends BaseToolPart {
  type: "tool-run_terminal_cmd";
  input?: {
    command: string;
    explanation: string;
    is_background: boolean;
  };
  output?: {
    result: {
      exitCode: number;
      stdout?: string;
      stderr?: string;
      error?: string;
    };
  };
}

// Interface for data parts that need to be collected
interface DataPart {
  type: string;
  data?: {
    toolCallId: string;
    [key: string]: any;
  };
}

/**
 * Normalizes chat messages by handling terminal tool output and cleaning up data parts.
 * Also prepares the last user message for backend sending.
 *
 * This function:
 * 1. Collects terminal output from data-terminal parts (only terminal tools use data streaming)
 * 2. Transforms interrupted terminal tools to capture their streaming output
 * 3. Removes data-terminal parts to clean up the message structure
 * 4. Prepares the last user message for backend to reduce payload size
 *
 * Note: Other incomplete tools are handled by backend (chat-processor.ts)
 *
 * @param messages - Array of UI messages to normalize
 * @returns Object with normalized messages, last message array, and hasChanges flag
 */
export const normalizeMessages = (
  messages: ChatMessage[],
): {
  messages: ChatMessage[];
  lastMessage: ChatMessage[];
  hasChanges: boolean;
} => {
  // Early return for empty messages
  if (!messages || messages.length === 0) {
    return { messages: [], lastMessage: [], hasChanges: false };
  }

  // Quick check: if no assistant messages, skip processing
  const hasAssistantMessages = messages.some((m) => m.role === "assistant");
  if (!hasAssistantMessages) {
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find((msg) => msg.role === "user");
    return {
      messages,
      lastMessage: lastUserMessage ? [lastUserMessage] : [],
      hasChanges: false,
    };
  }

  let hasChanges = false;
  const normalizedMessages = messages.map((message) => {
    // Only process assistant messages
    if (message.role !== "assistant" || !message.parts) {
      return message;
    }

    const processedParts: any[] = [];
    let messageChanged = false;

    // Collect terminal output from data-terminal parts (only terminal tools use data streaming)
    const terminalDataMap = new Map<string, string>();

    message.parts.forEach((part: any) => {
      const dataPart = part as DataPart;

      // Only handle data-terminal parts (other tools don't use data streaming)
      if (dataPart.type === "data-terminal" && dataPart.data?.toolCallId) {
        const toolCallId = dataPart.data.toolCallId;
        const terminalOutput = dataPart.data.terminal || "";

        // Accumulate terminal output for each toolCallId
        const existing = terminalDataMap.get(toolCallId) || "";
        terminalDataMap.set(toolCallId, existing + terminalOutput);
        messageChanged = true; // Data-terminal parts will be removed
      }
    });

    // Process each part, transform incomplete tools, filter out data-terminal parts, and strip providerMetadata
    message.parts.forEach((part: any) => {
      const toolPart = part as BaseToolPart;

      // Skip data-terminal parts - we've already collected their data
      if (toolPart.type === "data-terminal") {
        messageChanged = true; // Part is being removed
        return;
      }

      // Strip provider-specific fields from the part
      const hasProviderFields =
        "providerMetadata" in part ||
        "callProviderMetadata" in part ||
        "providerExecuted" in part ||
        "providerOptions" in part;
      const cleanPart = hasProviderFields
        ? stripProviderMetadataFromPart(part)
        : part;
      if (hasProviderFields) {
        messageChanged = true;
      }

      // Check if this is a terminal tool that needs transformation
      // Terminal tools need frontend handling to collect streaming output from data-terminal parts
      // Other incomplete tools are handled by backend (chat-processor.ts)
      const isTerminalTool = toolPart.type === "tool-run_terminal_cmd";
      const isIncomplete =
        toolPart.state === "input-available" ||
        toolPart.state === "input-streaming";

      if (isTerminalTool && isIncomplete) {
        // Transform terminal tools to collect streaming output
        const transformedPart = transformTerminalToolPart(
          cleanPart as TerminalToolPart,
          terminalDataMap,
        );
        processedParts.push(transformedPart);
        messageChanged = true;
      } else {
        // Keep other parts unchanged - backend handles incomplete non-terminal tools
        processedParts.push(cleanPart);
      }
    });

    if (messageChanged) {
      hasChanges = true;
    }

    return messageChanged
      ? {
          ...message,
          parts: processedParts,
        }
      : message;
  });

  // Prepare last message array with only the last user message
  const lastUserMessage = normalizedMessages
    .slice()
    .reverse()
    .find((msg) => msg.role === "user");

  const lastMessage = lastUserMessage ? [lastUserMessage] : [];

  return { messages: normalizedMessages, lastMessage, hasChanges };
};

/**
 * Transforms terminal tool parts with special handling for terminal output.
 * Collects streaming output from data-terminal parts before they're removed.
 */
const transformTerminalToolPart = (
  terminalPart: TerminalToolPart,
  terminalDataMap: Map<string, string>,
): BaseToolPart => {
  const stdout = terminalDataMap.get(terminalPart.toolCallId) || "";

  return {
    type: "tool-run_terminal_cmd",
    toolCallId: terminalPart.toolCallId,
    state: "output-available",
    input: terminalPart.input,
    output: {
      result: {
        exitCode: 130, // Standard exit code for SIGINT (interrupted)
        stdout: stdout,
        stderr:
          stdout.length === 0 ? "Command was stopped/aborted by user" : "",
      },
    },
  };
};

/**
 * Completes any incomplete tool calls in messages with a timeout result.
 * This prevents "Tool result is missing" errors when resuming after a preemptive timeout.
 */
/**
 * Checks if a part is a reasoning/thinking part.
 */
const isReasoningPart = (part: Record<string, any>): boolean => {
  return part.type === "reasoning" || part.type === "thinking";
};

/**
 * Strips reasoning parts from messages for Gemini models.
 * Gemini 3 with thinking mode requires thought_signature to be passed back with tool calls.
 * Since we don't store thought_signature, we strip reasoning parts to avoid the error:
 * "function call is missing a thought_signature"
 *
 * This is a safeguard for old messages that were saved without thought signatures.
 */
export const stripReasoningForGemini = <
  T extends { parts?: any[]; role?: string },
>(
  message: T,
): T => {
  if (!message.parts || message.role !== "assistant") return message;

  // Check if this message has any tool calls
  const hasToolCalls = message.parts.some(
    (part) => part.type?.startsWith("tool-") || part.type === "tool-call",
  );

  // Only strip reasoning if there are tool calls (that's when thought_signature is required)
  if (!hasToolCalls) return message;

  const filteredParts = message.parts.filter((part) => !isReasoningPart(part));

  // If no parts were removed, return original message
  if (filteredParts.length === message.parts.length) return message;

  return {
    ...message,
    parts: filteredParts,
  };
};

/**
 * Strips reasoning parts from all messages for Gemini models.
 * Use this before sending messages to Gemini to avoid thought_signature errors.
 */
export const stripReasoningFromMessagesForGemini = <
  T extends { parts?: any[]; role?: string },
>(
  messages: T[],
): T[] => {
  return messages.map(stripReasoningForGemini);
};

export const completeIncompleteToolCalls = <
  T extends { parts?: any[]; role?: string },
>(
  message: T,
  reason: string = "Operation timed out",
): T => {
  if (!message.parts || message.role !== "assistant") return message;

  const updatedParts = message.parts.map((part) => {
    // Check if this is a tool part that's still incomplete (streaming or waiting for execution)
    // Skip parts that already have a final state (output-available, output-error, result)
    if (
      part.type?.startsWith("tool-") &&
      (part.state === "input-streaming" || part.state === "input-available") &&
      part.toolCallId
    ) {
      // Handle terminal commands specially
      if (part.type === "tool-run_terminal_cmd") {
        return {
          ...part,
          state: "output-available",
          output: {
            result: {
              exitCode: 124, // Standard timeout exit code
              stdout: "",
              stderr: reason,
              error: reason,
            },
          },
        };
      }

      // Generic tool timeout result
      return {
        ...part,
        state: "output-available",
        output: {
          result: reason,
          error: reason,
        },
      };
    }

    return part;
  });

  return {
    ...message,
    parts: updatedParts,
  };
};
