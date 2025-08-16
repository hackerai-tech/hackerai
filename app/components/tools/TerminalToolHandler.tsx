import { UIMessage } from "@ai-sdk/react";
import { ShimmerText } from "../ShimmerText";
import { TerminalCodeBlock } from "../TerminalCodeBlock";
import { CommandResult } from "@e2b/code-interpreter";

interface TerminalToolHandlerProps {
  message: UIMessage;
  part: any;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const TerminalToolHandler = ({
  message,
  part,
  status,
}: TerminalToolHandlerProps) => {
  const { toolCallId, state, input, output } = part;
  const terminalInput = input as {
    command: string;
    is_background: boolean;
  };
  const terminalOutput = output as { result: CommandResult };

  // Get terminal data parts specific to this tool call for streaming output
  const terminalDataParts = message.parts.filter(
    (p) =>
      p.type === "data-terminal" && (p as any).data?.toolCallId === toolCallId,
  );
  const streamingOutput = terminalDataParts
    .map((p) => (p as any).data?.terminal || "")
    .join("");

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <div key={toolCallId} className="text-muted-foreground">
          <ShimmerText>Generating command</ShimmerText>
        </div>
      ) : null;
    case "input-available":
      return (
        <TerminalCodeBlock
          key={toolCallId}
          command={terminalInput.command}
          output={streamingOutput}
          isExecuting={true}
          status={status}
          isBackground={terminalInput.is_background}
        />
      );
    case "output-available": {
      const stdout = terminalOutput.result?.stdout ?? "";
      const stderr = terminalOutput.result?.stderr ?? "";
      const combinedOutput = stdout + stderr;
      const terminalOutputContent =
        combinedOutput || (terminalOutput.result?.error ?? "");

      return (
        <TerminalCodeBlock
          key={toolCallId}
          command={terminalInput.command}
          output={terminalOutputContent}
          status={status}
          isBackground={terminalInput.is_background}
        />
      );
    }
    default:
      return null;
  }
};
