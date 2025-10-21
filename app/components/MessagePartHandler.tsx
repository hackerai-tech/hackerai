import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { FileToolsHandler } from "./tools/FileToolsHandler";
import { TerminalToolHandler } from "./tools/TerminalToolHandler";
import { PythonToolHandler } from "./tools/PythonToolHandler";
import { WebSearchToolHandler, WebToolHandler } from "./tools/WebToolHandler";
import { TodoToolHandler } from "./tools/TodoToolHandler";
import { MemoryToolHandler } from "./tools/MemoryToolHandler";
import { GetTerminalFilesHandler } from "./tools/GetTerminalFilesHandler";
import { SummarizationHandler } from "./tools/SummarizationHandler";
import type { ChatStatus } from "@/types";
import { ReasoningHandler } from "./ReasoningHandler";

interface MessagePartHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
  status: ChatStatus;
  isLastMessage?: boolean;
}

export const MessagePartHandler = ({
  message,
  part,
  partIndex,
  status,
  isLastMessage,
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

    case "reasoning":
      return (
        <ReasoningHandler
          message={message}
          partIndex={partIndex}
          status={status}
          isLastMessage={isLastMessage}
        />
      );

    case "data-summarization":
      return (
        <SummarizationHandler
          message={message}
          part={part}
          partIndex={partIndex}
        />
      );

    case "tool-read_file":
    case "tool-write_file":
    case "tool-delete_file":
    case "tool-search_replace":
    case "tool-multi_edit":
      return <FileToolsHandler part={part} status={status} />;

    // Keep the old export for backward compatibility
    case "tool-web_search":
      return <WebSearchToolHandler part={part} status={status} />;

    case "tool-web":
      return <WebToolHandler part={part} status={status} />;

    case "data-terminal":
    case "tool-run_terminal_cmd":
      return (
        <TerminalToolHandler message={message} part={part} status={status} />
      );

    case "data-python":
    case "tool-python":
      return (
        <PythonToolHandler message={message} part={part} status={status} />
      );

    case "tool-get_terminal_files":
      return <GetTerminalFilesHandler part={part} status={status} />;

    case "tool-todo_write":
      return <TodoToolHandler message={message} part={part} status={status} />;

    case "tool-update_memory":
      return <MemoryToolHandler part={part} status={status} />;

    default:
      return null;
  }
};
