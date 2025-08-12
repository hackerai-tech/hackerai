import { UIMessage } from "@ai-sdk/react";
import { useState } from "react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { MessageActions } from "./MessageActions";
import { ToolHandler } from "./ToolHandler";

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

              case "tool-runTerminalCmd":
              case "tool-readFile":
              case "tool-writeFile": {
                const toolName = part.type.replace("tool-", "");
                return (
                  <ToolHandler
                    key={part.toolCallId}
                    part={part}
                    toolName={toolName}
                  />
                );
              }

              default: {
                return null;
              }
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
