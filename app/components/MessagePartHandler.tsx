import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { FileToolsHandler } from "./tools/FileToolsHandler";
import { FileHandler } from "./tools/FileHandler";
import { TerminalToolHandler } from "./tools/TerminalToolHandler";
import { HttpRequestToolHandler } from "./tools/HttpRequestToolHandler";
import { PythonToolHandler } from "./tools/PythonToolHandler";
import { WebToolHandler } from "./tools/WebToolHandler";
import { TodoToolHandler } from "./tools/TodoToolHandler";
import { MemoryToolHandler } from "./tools/MemoryToolHandler";
import { NotesToolHandler } from "./tools/NotesToolHandler";
import { GetTerminalFilesHandler } from "./tools/GetTerminalFilesHandler";
import { MatchToolHandler } from "./tools/MatchToolHandler";
import { SummarizationHandler } from "./tools/SummarizationHandler";
import type { ChatStatus } from "@/types";
import { ReasoningHandler } from "./ReasoningHandler";

interface MessagePartHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
  status: ChatStatus;
  isLastMessage?: boolean;
  /** Pre-computed terminal output by toolCallId (from message level) to avoid per-handler filtering */
  terminalOutputByToolCallId?: Map<string, string>;
}

// Memoized user text component - avoids re-renders for unchanged text
const UserTextPart = memo(function UserTextPart({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap">{text}</div>;
});

// Custom comparison for MessagePartHandler to minimize re-renders
function arePropsEqual(
  prevProps: MessagePartHandlerProps,
  nextProps: MessagePartHandlerProps,
): boolean {
  // Always re-render if status changes (streaming state)
  if (prevProps.status !== nextProps.status) return false;

  // Always re-render if isLastMessage changes
  if (prevProps.isLastMessage !== nextProps.isLastMessage) return false;

  // Check part reference - if same reference, no changes
  if (prevProps.part === nextProps.part) return true;

  // Pre-computed terminal map reference change should re-render
  if (
    prevProps.terminalOutputByToolCallId !==
    nextProps.terminalOutputByToolCallId
  )
    return false;

  // For tool parts, compare state and output which change during streaming
  if (
    prevProps.part?.type?.startsWith("tool-") ||
    prevProps.part?.type?.startsWith("data-")
  ) {
    return (
      prevProps.part.state === nextProps.part.state &&
      prevProps.part.toolCallId === nextProps.part.toolCallId &&
      prevProps.part.output === nextProps.part.output &&
      prevProps.part.input === nextProps.part.input
    );
  }

  // For text parts, compare text content
  if (prevProps.part?.type === "text") {
    return prevProps.part.text === nextProps.part.text;
  }

  // For reasoning, compare text
  if (prevProps.part?.type === "reasoning") {
    return (
      prevProps.part.text === nextProps.part.text &&
      prevProps.message.parts.length === nextProps.message.parts.length
    );
  }

  // Default: shallow compare part object
  return prevProps.part === nextProps.part;
}

export const MessagePartHandler = memo(function MessagePartHandler({
  message,
  part,
  partIndex,
  status,
  isLastMessage,
  terminalOutputByToolCallId,
}: MessagePartHandlerProps) {
  // Main switch for different part types
  switch (part.type) {
    case "text": {
      const isUser = message.role === "user";
      const text = part.text ?? "";

      // For user messages, use memoized plain text component
      if (isUser) {
        return <UserTextPart text={text} />;
      }

      // For assistant messages, use memoized markdown rendering
      return <MemoizedMarkdown content={text} />;
    }

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

    // Legacy file tools
    case "tool-read_file":
    case "tool-write_file":
    case "tool-delete_file":
    case "tool-search_replace":
    case "tool-multi_edit":
      return <FileToolsHandler message={message} part={part} status={status} />;

    case "tool-file":
      return <FileHandler part={part} status={status} />;

    case "tool-web_search":
    case "tool-open_url":
    case "tool-web": // Legacy tool
      return <WebToolHandler part={part} status={status} />;

    case "data-terminal":
    case "tool-shell":
    case "tool-run_terminal_cmd": {
      const effectiveToolCallId =
        (part as any).data?.toolCallId ?? part.toolCallId;
      const precomputedStreamingOutput = effectiveToolCallId
        ? terminalOutputByToolCallId?.get(effectiveToolCallId)
        : undefined;
      return (
        <TerminalToolHandler
          message={message}
          part={part}
          status={status}
          precomputedStreamingOutput={precomputedStreamingOutput}
        />
      );
    }

    // Legacy tool
    case "tool-http_request":
      return (
        <HttpRequestToolHandler message={message} part={part} status={status} />
      );

    // Legacy tool
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

    case "tool-create_note":
      return (
        <NotesToolHandler part={part} status={status} toolName="create_note" />
      );

    case "tool-list_notes":
      return (
        <NotesToolHandler part={part} status={status} toolName="list_notes" />
      );

    case "tool-update_note":
      return (
        <NotesToolHandler part={part} status={status} toolName="update_note" />
      );

    case "tool-delete_note":
      return (
        <NotesToolHandler part={part} status={status} toolName="delete_note" />
      );

    case "tool-match":
      return <MatchToolHandler part={part} status={status} />;

    default:
      return null;
  }
}, arePropsEqual);
