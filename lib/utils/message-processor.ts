import { ChatMessage } from "@/types/chat";

/**
 * Checks if a metadata object contains OpenRouter data.
 */
const hasOpenRouterMetadata = (metadata: unknown): boolean => {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    "openrouter" in metadata
  );
};

/**
 * Strips provider-specific fields from a single message part.
 * - providerMetadata/callProviderMetadata: only strips if it contains OpenRouter data
 * - providerExecuted/providerOptions: always strips (provider-internal data)
 */
export const stripProviderMetadataFromPart = <T extends Record<string, any>>(
  part: T,
): T => {
  let result = part;

  // Strip providerMetadata if it contains OpenRouter data
  if (
    "providerMetadata" in result &&
    hasOpenRouterMetadata(result.providerMetadata)
  ) {
    const { providerMetadata, ...rest } = result;
    result = rest as T;
  }

  // Strip callProviderMetadata if it contains OpenRouter data
  if (
    "callProviderMetadata" in result &&
    hasOpenRouterMetadata(result.callProviderMetadata)
  ) {
    const { callProviderMetadata, ...rest } = result;
    result = rest as T;
  }

  // Always strip providerExecuted
  if ("providerExecuted" in result) {
    const { providerExecuted, ...rest } = result;
    result = rest as T;
  }

  // Always strip providerOptions
  if ("providerOptions" in result) {
    const { providerOptions, ...rest } = result;
    result = rest as T;
  }

  return result;
};

/**
 * Strips OpenRouter providerMetadata and callProviderMetadata from all parts in a message.
 * Used to clean messages before saving or for temporary chat handling.
 */
export const stripProviderMetadata = <T extends { parts?: any[] }>(
  message: T,
): T => {
  if (!message.parts) return message;
  return {
    ...message,
    parts: message.parts.map(stripProviderMetadataFromPart),
  };
};

// Generic interface for all tool parts
interface BaseToolPart {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available";
  input?: any;
  output?: any;
}

/**
 * Strips originalContent and modifiedContent from file tool outputs to reduce payload size.
 * These are large and already handled by toModelOutput on the backend.
 */
const stripOriginalContentFromToolOutput = <T extends Record<string, any>>(
  part: T,
): T => {
  // Process tool-file parts with read, edit, or append action and object output
  if (
    part.type === "tool-file" &&
    (part.input?.action === "read" ||
      part.input?.action === "edit" ||
      part.input?.action === "append") &&
    typeof part.output === "object" &&
    part.output !== null &&
    ("originalContent" in part.output || "modifiedContent" in part.output)
  ) {
    const { originalContent, modifiedContent, ...restOutput } = part.output;
    return {
      ...part,
      output: restOutput,
    };
  }
  return part;
};

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
 * Normalizes chat messages by transforming incomplete tool calls and cleaning up data parts.
 * Also prepares the last user message for backend sending.
 *
 * This function:
 * 1. Collects terminal output from data-terminal parts (only terminal tools use data streaming)
 * 2. Transforms tools with input-available state to output-available state when interrupted
 * 3. Removes data-terminal parts to clean up the message structure
 * 4. Prepares the last user message for backend to reduce payload size
 *
 * Performance optimization: Early exits if no assistant messages or no changes needed
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

      // Strip provider-specific fields from the part (contains internal data like encrypted reasoning, provider options)
      const hasProviderFields =
        ("providerMetadata" in part &&
          hasOpenRouterMetadata(part.providerMetadata)) ||
        ("callProviderMetadata" in part &&
          hasOpenRouterMetadata(part.callProviderMetadata)) ||
        "providerExecuted" in part ||
        "providerOptions" in part;
      const cleanPart = hasProviderFields
        ? stripProviderMetadataFromPart(part)
        : part;
      if (hasProviderFields) {
        messageChanged = true;
      }

      // Check if this is a tool part that needs transformation
      if (toolPart.type?.startsWith("tool-")) {
        if (toolPart.state === "input-available") {
          // Transform incomplete tools to completed state
          const transformedPart = transformIncompleteToolPart(
            cleanPart as BaseToolPart,
            terminalDataMap,
          );
          processedParts.push(transformedPart);
          messageChanged = true; // Part is being transformed
        } else if (toolPart.state === "input-streaming") {
          // Transform streaming tools to completed state (they were interrupted)
          const transformedPart = transformIncompleteToolPart(
            { ...(cleanPart as BaseToolPart), state: "input-available" },
            terminalDataMap,
          );
          processedParts.push(transformedPart);
          messageChanged = true; // Part is being transformed
        } else {
          // Strip originalContent from file edit tool outputs (large data, already handled by toModelOutput)
          const strippedPart = stripOriginalContentFromToolOutput(cleanPart);
          if (strippedPart !== cleanPart) {
            messageChanged = true;
          }
          processedParts.push(strippedPart);
        }
      } else {
        // Keep non-tool parts unchanged
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
 * Transforms an incomplete tool part (input-available state) to a complete one (output-available state)
 * using collected terminal data for terminal tools.
 */
const transformIncompleteToolPart = (
  toolPart: BaseToolPart,
  terminalDataMap: Map<string, string>,
): BaseToolPart => {
  // Handle terminal tools with special terminal output handling
  if (toolPart.type === "tool-run_terminal_cmd") {
    return transformTerminalToolPart(
      toolPart as TerminalToolPart,
      terminalDataMap,
    );
  }

  // Handle all other tools generically (they don't have data streaming)
  return transformGenericToolPart(toolPart);
};

/**
 * Transforms terminal tool parts with special handling for terminal output
 */
const transformTerminalToolPart = (
  terminalPart: TerminalToolPart,
  terminalDataMap: Map<string, string>,
): TerminalToolPart => {
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
 * Generic transformation for all non-terminal tool types
 */
const transformGenericToolPart = (toolPart: BaseToolPart): BaseToolPart => {
  // Handle specific tool types with appropriate default outputs
  switch (toolPart.type) {
    case "tool-todo_write":
      return {
        ...toolPart,
        state: "output-available",
        output: {
          result: "Todo operation was interrupted by user",
          counts: { completed: 0, total: 0 },
          currentTodos: [],
        },
      };

    default:
      // Generic transformation for file tools and unknown tool types
      return {
        ...toolPart,
        state: "output-available",
        output: {
          result: "Operation was interrupted by user",
        },
      };
  }
};
