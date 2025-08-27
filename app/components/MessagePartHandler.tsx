import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { FileToolsHandler } from "./tools/FileToolsHandler";
import { TerminalToolHandler } from "./tools/TerminalToolHandler";
import { WebSearchToolHandler } from "./tools/WebSearchToolHandler";
import { TodoToolHandler } from "./tools/TodoToolHandler";
import type { ChatStatus } from "@/types";

interface MessagePartHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
  status: ChatStatus;
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
    return <MemoizedMarkdown key={partId} content={part.text ?? ""} />;
  };

  // Main switch for different part types
  switch (part.type) {
    case "text":
      return renderTextPart();

    case "tool-read_file":
    case "tool-write_file":
    case "tool-delete_file":
    case "tool-search_replace":
    case "tool-multi_edit":
      return <FileToolsHandler part={part} status={status} />;

    case "tool-web_search":
      return <WebSearchToolHandler part={part} status={status} />;

    case "data-terminal":
    case "tool-run_terminal_cmd":
      return (
        <TerminalToolHandler message={message} part={part} status={status} />
      );

    case "tool-todo_write":
      return <TodoToolHandler message={message} part={part} status={status} />;

    default:
      return null;
  }
};
