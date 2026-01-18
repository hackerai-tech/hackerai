"use client";

import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { FileToolsHandler } from "@/app/components/tools/FileToolsHandler";
import { TerminalToolHandler } from "@/app/components/tools/TerminalToolHandler";
import { ShellToolHandler } from "@/app/components/tools/ShellToolHandler";
import { PythonToolHandler } from "@/app/components/tools/PythonToolHandler";
import { WebToolHandler } from "@/app/components/tools/WebToolHandler";
import { TodoToolHandler } from "@/app/components/tools/TodoToolHandler";
import { MemoryToolHandler } from "@/app/components/tools/MemoryToolHandler";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { useSharedChatContext } from "./SharedChatContext";

interface SharedMessagePartHandlerProps {
  message: any;
  part: any;
  partIndex: number;
  isUser: boolean;
}

// Helper to collect consecutive reasoning text
const collectReasoningText = (parts: any[], startIndex: number): string => {
  const collected: string[] = [];
  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === "reasoning") {
      collected.push(part.text ?? "");
    } else {
      break;
    }
  }
  return collected.join("");
};

export const SharedMessagePartHandler = ({
  message,
  part,
  partIndex,
  isUser,
}: SharedMessagePartHandlerProps) => {
  const { openSidebar } = useSharedChatContext();
  const partId = `${message.id}-${partIndex}`;
  const parts = Array.isArray(message.parts) ? message.parts : [];

  // Reasoning blocks
  if (part.type === "reasoning") {
    // Skip if previous part is also reasoning (avoid duplicate renders)
    const previousPart = parts[partIndex - 1];
    if (previousPart?.type === "reasoning") return null;

    const combined = collectReasoningText(parts, partIndex);

    // Don't show reasoning if empty or only contains [REDACTED]
    if (!combined || /^(\[REDACTED\])+$/.test(combined.trim())) return null;

    return (
      <Reasoning key={partId} className="w-full" isStreaming={false}>
        <ReasoningTrigger />
        {combined && (
          <ReasoningContent>
            <MemoizedMarkdown content={combined} />
          </ReasoningContent>
        )}
      </Reasoning>
    );
  }

  // Text content
  if (part.type === "text" && part.text) {
    if (isUser) {
      return (
        <div key={partId} className="whitespace-pre-wrap">
          {part.text}
        </div>
      );
    }
    return <MemoizedMarkdown key={partId} content={part.text ?? ""} />;
  }

  // File tools
  if (
    part.type === "tool-read_file" ||
    part.type === "tool-write_file" ||
    part.type === "tool-delete_file" ||
    part.type === "tool-search_replace" ||
    part.type === "tool-multi_edit"
  ) {
    return (
      <FileToolsHandler
        key={partId}
        message={message}
        part={part}
        status="ready"
        externalOpenSidebar={openSidebar}
      />
    );
  }

  // Terminal commands (legacy)
  if (part.type === "data-terminal" || part.type === "tool-run_terminal_cmd") {
    return (
      <TerminalToolHandler
        key={partId}
        message={message}
        part={part}
        status="ready"
        externalOpenSidebar={openSidebar}
      />
    );
  }

  // Shell tool
  if (part.type === "tool-shell") {
    return (
      <ShellToolHandler
        key={partId}
        message={message}
        part={part}
        status="ready"
        externalOpenSidebar={openSidebar}
      />
    );
  }

  // Python execution
  if (part.type === "data-python" || part.type === "tool-python") {
    return (
      <PythonToolHandler
        key={partId}
        message={message}
        part={part}
        status="ready"
        externalOpenSidebar={openSidebar}
      />
    );
  }

  // Web search - reuse existing handler (no sidebar needed)
  if (
    part.type === "tool-web_search" ||
    part.type === "tool-open_url" ||
    part.type === "tool-web"
  ) {
    return <WebToolHandler key={partId} part={part} status="ready" />;
  }

  // Todo - reuse existing handler (no sidebar needed)
  if (part.type === "tool-todo_write") {
    return (
      <TodoToolHandler
        key={partId}
        message={message}
        part={part}
        status="ready"
      />
    );
  }

  // Memory - reuse existing handler (no sidebar needed)
  if (part.type === "tool-update_memory") {
    return <MemoryToolHandler key={partId} part={part} status="ready" />;
  }

  return null;
};
