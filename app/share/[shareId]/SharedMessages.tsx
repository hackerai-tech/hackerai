"use client";

import {
  ImageIcon,
  Terminal,
  FileCode,
  Search,
  Brain,
  CheckSquare,
  FileText,
  FilePlus,
  FilePen,
  FileMinus,
  Code2,
  FileIcon,
} from "lucide-react";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import ToolBlock from "@/components/ui/tool-block";
import { useSharedChatContext } from "./SharedChatContext";

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

export function SharedMessages({ messages, shareDate }: SharedMessagesProps) {
  const { openSidebar } = useSharedChatContext();
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground">
          No messages in this conversation
        </p>
      </div>
    );
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const renderPart = (part: MessagePart, idx: number, isUser: boolean) => {
    // Text content
    if (part.type === "text" && part.text) {
      return (
        <div key={idx}>
          {isUser ? part.text : <MemoizedMarkdown content={part.text} />}
        </div>
      );
    }

    // File/Image placeholder - simple indicator style
    if ((part.type === "file" || part.type === "image") && part.placeholder) {
      const isImage = part.type === "image";
      return (
        <div key={idx} className="flex gap-2 flex-wrap mt-1 w-full justify-end">
          <div className="text-muted-foreground flex items-center gap-2 whitespace-nowrap">
            {isImage ? (
              <ImageIcon className="w-5 h-5" />
            ) : (
              <FileIcon className="w-5 h-5" />
            )}
            <span>{isImage ? "Uploaded an image" : "Uploaded a file"}</span>
          </div>
        </div>
      );
    }

    // Terminal commands
    if (
      part.type === "data-terminal" ||
      part.type === "tool-run_terminal_cmd"
    ) {
      const terminalInput = part.input as { command?: string };
      const terminalOutput = part.output as {
        result?: string;
        output?: string;
      };
      const command = terminalInput?.command || "";
      const output = terminalOutput?.result || terminalOutput?.output || "";

      if (
        part.state === "input-available" ||
        part.state === "output-available" ||
        part.state === "output-error"
      ) {
        const handleOpenInSidebar = () => {
          openSidebar({
            command,
            output,
            isExecuting: false,
            toolCallId: part.toolCallId || "",
          });
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpenInSidebar();
          }
        };

        return (
          <ToolBlock
            key={idx}
            icon={<Terminal />}
            action="Executed"
            target={command}
            isClickable={true}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
          />
        );
      }
    }

    // File operations
    if (
      part.type === "tool-read_file" ||
      part.type === "tool-write_file" ||
      part.type === "tool-delete_file" ||
      part.type === "tool-search_replace" ||
      part.type === "tool-multi_edit"
    ) {
      const fileInput = part.input as {
        file_path?: string;
        path?: string;
        target_file?: string;
        offset?: number;
        limit?: number;
        content?: string;
      };
      const fileOutput = part.output as { result?: string };
      const filePath =
        fileInput?.file_path || fileInput?.path || fileInput?.target_file || "";

      let action = "File operation";
      let icon = <FileCode />;
      let sidebarAction: "reading" | "creating" | "editing" | "writing" =
        "reading";

      if (part.type === "tool-read_file") {
        action = "Read";
        icon = <FileText />;
        sidebarAction = "reading";
      }
      if (part.type === "tool-write_file") {
        action = "Wrote";
        icon = <FilePlus />;
        sidebarAction = "writing";
      }
      if (part.type === "tool-delete_file") {
        action = "Deleted";
        icon = <FileMinus />;
      }
      if (
        part.type === "tool-search_replace" ||
        part.type === "tool-multi_edit"
      ) {
        action = "Edited";
        icon = <FilePen />;
        sidebarAction = "editing";
      }

      if (part.state === "output-available") {
        // For delete operations, don't make it clickable (no content to show)
        if (part.type === "tool-delete_file") {
          return (
            <ToolBlock
              key={idx}
              icon={icon}
              action={action}
              target={filePath}
            />
          );
        }

        const handleOpenInSidebar = () => {
          let content = "";

          if (part.type === "tool-read_file") {
            // Clean line numbers from read output
            content = (fileOutput?.result || "").replace(/^\s*\d+\|/gm, "");
          } else if (part.type === "tool-write_file") {
            content = fileInput?.content || "";
          } else {
            content = fileOutput?.result || "";
          }

          const range =
            fileInput?.offset && fileInput?.limit
              ? {
                  start: fileInput.offset,
                  end: fileInput.offset + fileInput.limit - 1,
                }
              : undefined;

          openSidebar({
            path: filePath,
            content,
            range,
            action: sidebarAction,
          });
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpenInSidebar();
          }
        };

        return (
          <ToolBlock
            key={idx}
            icon={icon}
            action={action}
            target={filePath}
            isClickable={true}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
          />
        );
      }
    }

    // Python execution
    if (part.type === "data-python" || part.type === "tool-python") {
      const pythonInput = part.input as { code?: string };
      const pythonOutput = part.output as { result?: string; output?: string };
      const code = pythonInput?.code || "";
      const output = pythonOutput?.result || pythonOutput?.output || "";
      const codePreview = code.split("\n")[0]?.substring(0, 50);

      if (
        part.state === "input-available" ||
        part.state === "output-available"
      ) {
        const handleOpenInSidebar = () => {
          openSidebar({
            code,
            output,
            isExecuting: false,
            toolCallId: part.toolCallId || "",
          });
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpenInSidebar();
          }
        };

        return (
          <ToolBlock
            key={idx}
            icon={<Code2 />}
            action="Executed Python"
            target={codePreview}
            isClickable={true}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
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
          <ToolBlock key={idx} icon={<CheckSquare />} action="Updated todos" />
        );
      }
    }

    if (part.type === "tool-update_memory") {
      if (part.state === "output-available") {
        return <ToolBlock key={idx} icon={<Brain />} action="Updated memory" />;
      }
    }

    return null;
  };

  return (
    <>
      {/* Shared conversation notice */}
      <div
        className="text-center text-[12px] font-normal"
        style={{ color: "rgb(155, 155, 155)" }}
      >
        This is a copy of a conversation between HackerAI & Anonymous.
      </div>

      {/* Messages */}
      {messages.map((message) => {
        const isUser = message.role === "user";

        // Separate file/image placeholders from other parts
        const filePlaceholders = message.parts.filter(
          (part) =>
            (part.type === "file" || part.type === "image") && part.placeholder,
        );
        const otherParts = message.parts.filter(
          (part) =>
            !(
              (part.type === "file" || part.type === "image") &&
              part.placeholder
            ),
        );

        return (
          <div
            key={message.id}
            className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
          >
            <div
              className={`${
                isUser
                  ? "w-full flex flex-col gap-1 items-end"
                  : "w-full text-foreground"
              } overflow-hidden`}
            >
              {/* File/Image placeholders - rendered outside bubble */}
              {isUser && filePlaceholders.length > 0 && (
                <div className="flex gap-2 flex-wrap mt-1 max-w-[80%] justify-end">
                  {filePlaceholders.map((part, idx) => {
                    const isImage = part.type === "image";
                    return (
                      <div
                        key={idx}
                        className="text-muted-foreground flex items-center gap-2 whitespace-nowrap"
                      >
                        {isImage ? (
                          <ImageIcon className="w-5 h-5" />
                        ) : (
                          <FileIcon className="w-5 h-5" />
                        )}
                        <span>
                          {isImage ? "Uploaded an image" : "Uploaded a file"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Message bubble with other parts */}
              {otherParts.length > 0 && (
                <div
                  className={`${
                    isUser
                      ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                      : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                  } overflow-hidden`}
                >
                  {/* Message Parts */}
                  {isUser ? (
                    <div className="whitespace-pre-wrap">
                      {otherParts.map((part, idx) => renderPart(part, idx, isUser))}
                    </div>
                  ) : (
                    otherParts.map((part, idx) => renderPart(part, idx, isUser))
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
