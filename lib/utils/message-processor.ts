import { UIMessage } from "ai";

interface TerminalToolPart {
  type: "tool-runTerminalCmd";
  toolCallId: string;
  state: "input-available" | "output-available" | "input-streaming";
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

/**
 * Normalizes chat messages by transforming incomplete terminal commands and cleaning up data-terminal parts.
 *
 * This function:
 * 1. Collects terminal output from data-terminal parts
 * 2. Transforms tool-runTerminalCmd with input-available state to output-available state
 * 3. Removes data-terminal parts to clean up the message structure
 *
 * @param messages - Array of UI messages to normalize
 * @returns Normalized messages with complete terminal commands and cleaned structure
 */
export const normalizeMessages = (messages: UIMessage[]): UIMessage[] => {
  return messages.map((message) => {
    // Only process assistant messages
    if (message.role !== "assistant" || !message.parts) {
      return message;
    }

    const processedParts: any[] = [];

    // First, collect all terminal data by toolCallId from data-terminal parts
    const terminalDataMap = new Map<string, string>();
    message.parts.forEach((part: any) => {
      if (part.type === "data-terminal" && part.data?.toolCallId) {
        const toolCallId = part.data.toolCallId;
        const terminalOutput = part.data.terminal || "";

        // Accumulate terminal output for each toolCallId
        const existing = terminalDataMap.get(toolCallId) || "";
        terminalDataMap.set(toolCallId, existing + terminalOutput);
      }
    });

    // Process each part, transform terminal commands, and filter out data-terminal parts
    message.parts.forEach((part: any) => {
      // Skip data-terminal parts - we've already collected their data
      if (part.type === "data-terminal") {
        return;
      }

      // Check if this is a terminal input part that needs transformation
      if (
        part.type === "tool-runTerminalCmd" &&
        (part as TerminalToolPart).state === "input-available"
      ) {
        const terminalPart = part as TerminalToolPart;
        const toolCallId = terminalPart.toolCallId;

        // Get accumulated terminal output for this toolCallId
        const stdout = terminalDataMap.get(toolCallId) || "";

        // Transform to output-available with collected terminal output
        // Since we're processing input-available state, the command was interrupted/stopped
        const transformedPart: TerminalToolPart = {
          type: "tool-runTerminalCmd",
          toolCallId: toolCallId,
          state: "output-available",
          input: terminalPart.input,
          output: {
            result: {
              exitCode: 130, // Standard exit code for SIGINT (interrupted)
              stdout: stdout,
              stderr:
                stdout.length === 0
                  ? "Command was stopped/aborted by user"
                  : "",
            },
          },
        };

        processedParts.push(transformedPart);
      } else {
        // Keep other parts unchanged
        processedParts.push(part);
      }
    });

    return {
      ...message,
      parts: processedParts,
    } as UIMessage;
  });
};
