import { UIMessage } from "@ai-sdk/react";
import { useState } from "react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { MessageActions } from "./MessageActions";
import { ToolHandler } from "./ToolHandler";
import DotsSpinner from "@/components/ui/dots-spinner";
import { ShimmerText } from "./ShimmerText";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { CommandResult } from "@e2b/code-interpreter";

interface MessageProps {
  message: UIMessage;
  onRegenerate: () => void;
  canRegenerate: boolean;
  isLastAssistantMessage: boolean;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const Message = ({
  message,
  onRegenerate,
  canRegenerate,
  isLastAssistantMessage,
  status,
}: MessageProps) => {
  const isUser = message.role === "user";
  const [isHovered, setIsHovered] = useState(false);

  // Check if we should show loader for this message
  const hasTextContent = message.parts?.some(
    (part: { type: string; text?: string }) =>
      part.type === "text" && part.text && part.text.trim() !== "",
  );

  const shouldShowLoader =
    isLastAssistantMessage && status === "streaming" && !hasTextContent;

  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={`${
          isUser
            ? "max-w-[80%] bg-secondary rounded-lg px-4 py-3 text-primary-foreground border border-border"
            : "w-full text-foreground"
        } overflow-hidden`}
      >
        <div className="prose space-y-3 prose-sm max-w-none dark:prose-invert min-w-0 overflow-hidden">
          {message.parts.map((part, partIndex) => {
            switch (part.type) {
              case "text": {
                const partId = `${message.id}-text-${partIndex}`;
                return (
                  <MemoizedMarkdown
                    key={partId}
                    id={partId}
                    content={part.text ?? ""}
                  />
                );
              }

              case "tool-readFile":
              case "tool-writeFile": {
                const toolName = part.type.replace("tool-", "");
                return (
                  <ToolHandler
                    key={part.toolCallId}
                    part={part}
                    toolName={toolName}
                    status={status}
                  />
                );
              }

              case "data-terminal":
              case "tool-runTerminalCmd": {
                const { toolCallId, state, input, output } = part as any;
                const terminalInput = input as {
                  command: string;
                  is_background: boolean;
                };
                const terminalOutput = output as { result: CommandResult };

                // Get terminal data parts specific to this tool call for streaming output
                const terminalDataParts = message.parts.filter(
                  (p) =>
                    p.type === "data-terminal" &&
                    (p as any).data?.toolCallId === toolCallId,
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
                      />
                    );
                  case "output-available":
                    const terminalOutputContent =
                      terminalOutput.result.stdout +
                        terminalOutput.result.stderr ||
                      terminalOutput.result.error;
                    return (
                      <TerminalCodeBlock
                        key={toolCallId}
                        command={terminalInput.command}
                        output={terminalOutputContent}
                        status={status}
                      />
                    );
                  default:
                    return null;
                }
              }

              default: {
                return null;
              }
            }
          })}
        </div>
      </div>

      {/* Loading state */}
      {shouldShowLoader && (
        <div className="mt-1 flex justify-start">
          <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 flex items-center space-x-2">
            <DotsSpinner size="sm" variant="primary" />
          </div>
        </div>
      )}

      <MessageActions
        messageParts={message.parts}
        isUser={isUser}
        isLastAssistantMessage={isLastAssistantMessage}
        canRegenerate={canRegenerate}
        onRegenerate={onRegenerate}
        isHovered={isHovered}
        status={status}
      />
    </div>
  );
};
