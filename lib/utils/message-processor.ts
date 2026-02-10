import type { UIToolInvocation } from "ai";
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
  state: UIToolInvocation<any>["state"];
  input?: any;
  output?: any;
  result?: any; // legacy
}

// Specific interface for terminal tools that have special data handling
interface TerminalToolPart extends BaseToolPart {
  type: "tool-run_terminal_cmd" | "tool-shell";
  input?: {
    command?: string;
    explanation?: string;
    is_background?: boolean;
    // Shell tool fields
    action?: string;
    brief?: string;
    pid?: number;
    input?: string;
    timeout?: number;
  };
  output?: {
    result?: {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      error?: string;
    };
    output?: string;
    exitCode?: number | null;
    pid?: number;
    error?: boolean | string;
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

    // Process each part, transform incomplete tools, filter out data-terminal parts
    // NOTE: We intentionally keep providerMetadata - Gemini requires thought_signature for tool calls
    message.parts.forEach((part: any) => {
      const toolPart = part as BaseToolPart;

      // Skip data-terminal parts - we've already collected their data
      if (toolPart.type === "data-terminal") {
        messageChanged = true; // Part is being removed
        return;
      }

      // Check if this is a terminal tool that needs transformation
      // Terminal tools need frontend handling to collect streaming output from data-terminal parts
      // Other incomplete tools are handled by backend (chat-processor.ts)
      const isTerminalTool =
        toolPart.type === "tool-run_terminal_cmd" ||
        toolPart.type === "tool-shell";
      const isIncomplete =
        toolPart.state === "input-available" ||
        toolPart.state === "input-streaming";

      if (isTerminalTool && isIncomplete) {
        // Transform terminal tools to collect streaming output
        const transformedPart = transformTerminalToolPart(
          part as TerminalToolPart,
          terminalDataMap,
        );
        processedParts.push(transformedPart);
        messageChanged = true;
      } else {
        // Keep parts unchanged - backend handles incomplete non-terminal tools
        processedParts.push(part);
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

  // Shell tool returns { output: string } directly, not nested in result
  if (terminalPart.type === "tool-shell") {
    return {
      type: "tool-shell",
      toolCallId: terminalPart.toolCallId,
      state: "output-available",
      input: terminalPart.input,
      output: {
        output:
          stdout ||
          (stdout.length === 0 ? "Command was stopped/aborted by user" : ""),
      },
    };
  }

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
