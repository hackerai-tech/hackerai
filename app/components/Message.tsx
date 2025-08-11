import { UIMessage } from "@ai-sdk/react";
import { useState } from "react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ShimmerText } from "./ShimmerText";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { MessageActions } from "./MessageActions";

interface MessageProps {
  message: UIMessage;
  onRegenerate: () => void;
  canRegenerate: boolean;
  isLastAssistantMessage: boolean;
}

export const Message = ({
  message,
  onRegenerate,
  canRegenerate,
  isLastAssistantMessage,
}: MessageProps) => {
  const isUser = message.role === "user";
  const [isHovered, setIsHovered] = useState(false);

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
              case "text":
                const partId = `${message.id}-text-${partIndex}`;
                return (
                  <MemoizedMarkdown
                    key={partId}
                    id={partId}
                    content={part.text ?? ""}
                  />
                );

              case "tool-runTerminalCmd":
                const callId = part.toolCallId;
                const input = part.input as {
                  command: string;
                  // explanation?: string;
                  is_background: boolean;
                };

                switch (part.state) {
                  case "input-streaming":
                    return (
                      <div key={callId} className="text-muted-foreground">
                        <ShimmerText>Generating command</ShimmerText>
                      </div>
                    );
                  case "input-available":
                    return (
                      <TerminalCodeBlock
                        key={callId}
                        command={input.command}
                        isExecuting={true}
                      />
                    );
                  case "output-available":
                    const output = part.output as { result: string };
                    return (
                      <TerminalCodeBlock
                        key={callId}
                        command={input.command}
                        output={output.result}
                      />
                    );
                }

              default:
                return null;
            }
          })}
        </div>
      </div>

      <MessageActions
        messageParts={message.parts}
        isUser={isUser}
        isLastAssistantMessage={isLastAssistantMessage}
        canRegenerate={canRegenerate}
        onRegenerate={onRegenerate}
        isHovered={isHovered}
      />
    </div>
  );
};
