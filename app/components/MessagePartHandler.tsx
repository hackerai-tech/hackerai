import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { FileToolsHandler } from "./tools/FileToolsHandler";
import { TerminalToolHandler } from "./tools/TerminalToolHandler";
import { WebSearchToolHandler } from "./tools/WebSearchToolHandler";

interface MessagePartHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const MessagePartHandler = ({
  message,
  part,
  partIndex,
  status,
}: MessagePartHandlerProps) => {
  const renderTextPart = () => {
    const partId = `${message.id}-text-${partIndex}`;
    const isUser = message.role === "user";

    // For user messages, render plain text to avoid markdown processing
    if (isUser) {
      return (
        <div key={partId} className="whitespace-pre-wrap">
          {part.text ?? ""}
        </div>
      );
    }

    // For assistant messages, use markdown rendering
    return (
      <MemoizedMarkdown key={partId} id={partId} content={part.text ?? ""} />
    );
  };

  // Main switch for different part types
  switch (part.type) {
    case "text":
      return renderTextPart();

    case "tool-readFile":
    case "tool-writeFile":
    case "tool-deleteFile":
    case "tool-searchReplace":
    case "tool-multiEdit":
      return <FileToolsHandler part={part} status={status} />;
      
    case "tool-webSearch":
      return <WebSearchToolHandler part={part} status={status} />;
      
    case "data-terminal":
    case "tool-runTerminalCmd":
      return (
        <TerminalToolHandler message={message} part={part} status={status} />
      );

    default:
      return null;
  }
};
