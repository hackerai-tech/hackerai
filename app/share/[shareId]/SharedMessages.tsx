"use client";

import { FileIcon, ImageIcon, Clock, Terminal, FileCode, Search, Brain, CheckSquare } from "lucide-react";

interface MessagePart {
  type: string;
  text?: string;
  placeholder?: boolean;
  state?: string;
  input?: any;
  output?: any;
  toolCallId?: string;
  errorText?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  content?: string;
  update_time: number;
}

interface SharedMessagesProps {
  messages: Message[];
  shareDate: number;
}

// Helper component for rendering tool blocks in shared view
function ToolBlock({ icon, action, target }: { icon: React.ReactNode; action: string; target?: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="rounded-[15px] px-[10px] py-[6px] border border-border bg-muted/20 inline-flex max-w-full gap-[4px] items-center relative h-[36px] overflow-hidden">
        <div className="w-[21px] inline-flex items-center flex-shrink-0 text-foreground [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </div>
        <div className="max-w-[100%] truncate text-muted-foreground relative top-[-1px]">
          <span className="text-[13px]">{action}</span>
          {target && (
            <span className="text-[12px] font-mono ml-[6px] text-muted-foreground/70">
              {target}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SharedMessages({ messages, shareDate }: SharedMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground">No messages in this conversation</p>
      </div>
    );
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const renderPart = (part: MessagePart, idx: number) => {
    // Text content
    if (part.type === "text" && part.text) {
      return (
        <div key={idx}>
          {part.text}
        </div>
      );
    }

    // File/Image placeholder - match regular chat style
    if ((part.type === "file" || part.type === "image") && part.placeholder) {
      const isImage = part.type === "image";
      return (
        <div key={idx} className="p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background">
          <div className="flex flex-row items-center gap-2">
            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-[#FF5588] flex items-center justify-center">
              {isImage ? (
                <ImageIcon className="h-6 w-6 text-white" />
              ) : (
                <FileIcon className="h-6 w-6 text-white" />
              )}
            </div>
            <div className="overflow-hidden flex-1">
              <div className="truncate font-semibold text-sm text-left">
                {isImage ? "Image" : "Document"}
              </div>
              <div className="text-muted-foreground truncate text-xs text-left">
                {isImage ? "Image" : "Document"}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Terminal commands
    if (part.type === "data-terminal" || part.type === "tool-run_terminal_cmd") {
      const terminalInput = part.input as { command?: string };
      const command = terminalInput?.command;

      if (part.state === "input-available" || part.state === "output-available" || part.state === "output-error") {
        return (
          <ToolBlock
            key={idx}
            icon={<Terminal />}
            action="Executed"
            target={command}
          />
        );
      }
    }

    // File operations
    if (part.type === "tool-read_file" || part.type === "tool-write_file" ||
        part.type === "tool-delete_file" || part.type === "tool-search_replace" ||
        part.type === "tool-multi_edit") {
      const fileInput = part.input as { file_path?: string; path?: string };
      const filePath = fileInput?.file_path || fileInput?.path;

      let action = "File operation";
      if (part.type === "tool-read_file") action = "Read";
      if (part.type === "tool-write_file") action = "Wrote";
      if (part.type === "tool-delete_file") action = "Deleted";
      if (part.type === "tool-search_replace") action = "Edited";
      if (part.type === "tool-multi_edit") action = "Edited";

      if (part.state === "output-available") {
        return (
          <ToolBlock
            key={idx}
            icon={<FileCode />}
            action={action}
            target={filePath}
          />
        );
      }
    }

    // Python execution
    if (part.type === "data-python" || part.type === "tool-python") {
      const pythonInput = part.input as { code?: string };
      const codePreview = pythonInput?.code?.split('\n')[0]?.substring(0, 50);

      if (part.state === "input-available" || part.state === "output-available") {
        return (
          <ToolBlock
            key={idx}
            icon={<Terminal />}
            action="Executed Python"
            target={codePreview}
          />
        );
      }
    }

    // Web search
    if (part.type === "tool-web_search" || part.type === "tool-web") {
      const webInput = part.input as { query?: string; url?: string };
      const target = webInput?.query || webInput?.url;

      if (part.state === "output-available") {
        return (
          <ToolBlock
            key={idx}
            icon={<Search />}
            action={part.type === "tool-web_search" ? "Searched" : "Fetched"}
            target={target}
          />
        );
      }
    }

    // Todo/Memory operations
    if (part.type === "tool-todo_write") {
      if (part.state === "output-available") {
        return (
          <ToolBlock
            key={idx}
            icon={<CheckSquare />}
            action="Updated todos"
          />
        );
      }
    }

    if (part.type === "tool-update_memory") {
      if (part.state === "output-available") {
        return (
          <ToolBlock
            key={idx}
            icon={<Brain />}
            action="Updated memory"
          />
        );
      }
    }

    return null;
  };

  return (
    <div className="space-y-6">
      {/* Frozen Content Notice */}
      <div className="bg-muted/50 border rounded-lg p-4 flex items-start gap-3">
        <Clock className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Frozen Snapshot</p>
          <p className="text-xs text-muted-foreground">
            This share shows messages as they were on{" "}
            {new Date(shareDate).toLocaleString()}. Newer messages are not
            included.
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-4">
        {messages.map((message) => {
          const isUser = message.role === "user";

          return (
            <div
              key={message.id}
              className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
            >
              <div
                className={`${
                  isUser
                    ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                    : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                } overflow-hidden`}
              >
                {/* Message Parts */}
                <div className={isUser ? "whitespace-pre-wrap" : ""}>
                  {message.parts.map((part, idx) => renderPart(part, idx))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* End Notice */}
      <div className="text-center text-sm text-muted-foreground pt-6 border-t">
        End of shared conversation ({messages.length} message
        {messages.length !== 1 ? "s" : ""})
      </div>
    </div>
  );
}
