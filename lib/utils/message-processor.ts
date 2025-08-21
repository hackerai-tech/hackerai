import { UIMessage } from "ai";

// Generic interface for all tool parts
interface BaseToolPart {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available";
  input?: any;
  output?: any;
}

// Specific interface for terminal tools that have special data handling
interface TerminalToolPart extends BaseToolPart {
  type: "tool-runTerminalCmd";
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
 *
 * This function:
 * 1. Collects terminal output from data-terminal parts (only terminal tools use data streaming)
 * 2. Transforms tools with input-available state to output-available state when interrupted
 * 3. Removes data-terminal parts to clean up the message structure
 *
 * @param messages - Array of UI messages to normalize
 * @returns Object with normalized messages and hasChanges flag
 */
export const normalizeMessages = (
  messages: UIMessage[],
): { messages: UIMessage[]; hasChanges: boolean } => {
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

    // Process each part, transform incomplete tools, and filter out data-terminal parts
    message.parts.forEach((part: any) => {
      const toolPart = part as BaseToolPart;

      // Skip data-terminal parts - we've already collected their data
      if (toolPart.type === "data-terminal") {
        messageChanged = true; // Part is being removed
        return;
      }

      // Check if this is a tool part that needs transformation
      if (toolPart.type?.startsWith("tool-")) {
        if (toolPart.state === "input-available") {
          // Transform incomplete tools to completed state
          const transformedPart = transformIncompleteToolPart(
            toolPart,
            terminalDataMap,
          );
          processedParts.push(transformedPart);
          messageChanged = true; // Part is being transformed
        } else if (toolPart.state === "input-streaming") {
          // Transform streaming tools to completed state (they were interrupted)
          const transformedPart = transformIncompleteToolPart(
            { ...toolPart, state: "input-available" },
            terminalDataMap,
          );
          processedParts.push(transformedPart);
          messageChanged = true; // Part is being transformed
        } else {
          // Keep completed tools unchanged
          processedParts.push(part);
        }
      } else {
        // Keep non-tool parts unchanged
        processedParts.push(part);
      }
    });

    if (messageChanged) {
      hasChanges = true;
    }

    return {
      ...message,
      parts: processedParts,
    } as UIMessage;
  });

  return { messages: normalizedMessages, hasChanges };
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
  if (toolPart.type === "tool-runTerminalCmd") {
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
    type: "tool-runTerminalCmd",
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
    case "tool-todoWrite":
    case "tool-todoManager":
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
