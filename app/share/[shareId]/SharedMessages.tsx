"use client";

import { ImageIcon, Terminal, FileCode, Search, Brain, CheckSquare, FileText, FilePlus, FilePen, FileMinus, Code2 } from "lucide-react";
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
          <MemoizedMarkdown content={part.text} />
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
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className="w-5 h-5">
                <path d="M16.6182 9.33203H3.38184V12.7002C3.38184 13.3753 3.38238 13.8438 3.41211 14.208C3.44124 14.5646 3.49494 14.766 3.57129 14.916L3.63867 15.0361C3.80618 15.3094 4.04683 15.5324 4.33399 15.6787L4.45703 15.7314C4.59362 15.7803 4.77411 15.816 5.04199 15.8379C5.40624 15.8676 5.87469 15.8682 6.54981 15.8682H13.4502C14.1253 15.8682 14.5938 15.8676 14.958 15.8379C15.3146 15.8088 15.516 15.7551 15.666 15.6787L15.7861 15.6113C16.0594 15.4438 16.2824 15.2032 16.4287 14.916L16.4814 14.793C16.5303 14.6564 16.566 14.4759 16.5879 14.208C16.6176 13.8438 16.6182 13.3753 16.6182 12.7002V9.33203ZM17.8818 12.7002C17.8818 13.3547 17.8826 13.8838 17.8477 14.3115C17.8165 14.6922 17.7543 15.0349 17.6172 15.3545L17.5537 15.4902C17.3015 15.9852 16.9182 16.3996 16.4473 16.6885L16.2402 16.8037C15.8824 16.9861 15.4966 17.0621 15.0615 17.0977C14.6338 17.1326 14.1047 17.1318 13.4502 17.1318H6.54981C5.89526 17.1318 5.36616 17.1326 4.93848 17.0977C4.55777 17.0665 4.21506 17.0043 3.89551 16.8672L3.75977 16.8037C3.26483 16.5515 2.85036 16.1682 2.56152 15.6973L2.44629 15.4902C2.26394 15.1324 2.1879 14.7466 2.15235 14.3115C2.1174 13.8838 2.11817 13.3547 2.11817 12.7002V7.29981C2.11817 6.64526 2.1174 6.11616 2.15235 5.68848C2.1879 5.25344 2.26394 4.86765 2.44629 4.50977L2.56152 4.30274C2.85036 3.83179 3.26483 3.44854 3.75977 3.19629L3.89551 3.13281C4.21506 2.99571 4.55777 2.93346 4.93848 2.90235C5.36616 2.8674 5.89526 2.86817 6.54981 2.86817H7.24512C7.38876 2.86816 7.48717 2.86807 7.58399 2.87402L7.83496 2.90039C8.41501 2.98537 8.96006 3.23832 9.40039 3.63086L9.64356 3.86817C9.75546 3.98103 9.79343 4.0181 9.83008 4.05078L9.94238 4.14356C10.2142 4.34787 10.5413 4.46917 10.8828 4.49024L11.1445 4.49317H13.4502C14.1047 4.49317 14.6338 4.4924 15.0615 4.52735C15.4966 4.5629 15.8824 4.63894 16.2402 4.82129L16.4473 4.93652C16.9182 5.22536 17.3015 5.63983 17.5537 6.13477L17.6172 6.27051C17.7543 6.59006 17.8165 6.93277 17.8477 7.31348C17.8826 7.74116 17.8818 8.27026 17.8818 8.92481V12.7002ZM3.38184 8.06836H16.6143C16.6105 7.81516 16.603 7.60256 16.5879 7.41699C16.566 7.14911 16.5303 6.96862 16.4814 6.83203L16.4287 6.70899C16.2824 6.42183 16.0594 6.18118 15.7861 6.01367L15.666 5.94629C15.516 5.86994 15.3146 5.81624 14.958 5.78711C14.5938 5.75738 14.1253 5.75684 13.4502 5.75684H11.1445L10.8047 5.75098C10.2158 5.71466 9.65236 5.50645 9.1836 5.1543L8.98926 4.99414C8.91673 4.92948 8.84746 4.85908 8.7461 4.75684L8.55957 4.57422C8.30416 4.34653 7.98784 4.19959 7.65137 4.15039L7.50684 4.13477C7.45779 4.13174 7.4043 4.13184 7.24512 4.13184H6.54981C5.87469 4.13184 5.40624 4.13238 5.04199 4.16211C4.77411 4.184 4.59362 4.21966 4.45703 4.26856L4.33399 4.32129C4.04683 4.4676 3.80618 4.69061 3.63867 4.96387L3.57129 5.08399C3.49494 5.23405 3.44124 5.43543 3.41211 5.79199C3.38238 6.15624 3.38184 6.62469 3.38184 7.29981V8.06836Z"></path>
              </svg>
            )}
            <span>{isImage ? "Uploaded an image" : "Uploaded a file"}</span>
          </div>
        </div>
      );
    }

    // Terminal commands
    if (part.type === "data-terminal" || part.type === "tool-run_terminal_cmd") {
      const terminalInput = part.input as { command?: string };
      const terminalOutput = part.output as { result?: string; output?: string };
      const command = terminalInput?.command || "";
      const output = terminalOutput?.result || terminalOutput?.output || "";

      if (part.state === "input-available" || part.state === "output-available" || part.state === "output-error") {
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
    if (part.type === "tool-read_file" || part.type === "tool-write_file" ||
        part.type === "tool-delete_file" || part.type === "tool-search_replace" ||
        part.type === "tool-multi_edit") {
      const fileInput = part.input as { file_path?: string; path?: string; target_file?: string; offset?: number; limit?: number; content?: string };
      const fileOutput = part.output as { result?: string };
      const filePath = fileInput?.file_path || fileInput?.path || fileInput?.target_file || "";

      let action = "File operation";
      let icon = <FileCode />;
      let sidebarAction: "reading" | "creating" | "editing" | "writing" = "reading";

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
      if (part.type === "tool-search_replace" || part.type === "tool-multi_edit") {
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
      const codePreview = code.split('\n')[0]?.substring(0, 50);

      if (part.state === "input-available" || part.state === "output-available") {
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
    <>
      {/* Shared conversation notice */}
      <div className="text-center text-[12px] font-normal" style={{ color: 'rgb(155, 155, 155)' }}>
        This is a copy of a conversation between HackerAI & Anonymous.
      </div>

      {/* Messages */}
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
                    ? "w-full flex flex-col gap-1 items-end"
                    : "w-full text-foreground"
                } overflow-hidden`}
              >
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
                      {message.parts.map((part, idx) => renderPart(part, idx))}
                    </div>
                  ) : (
                    message.parts.map((part, idx) => renderPart(part, idx))
                  )}
                </div>
              </div>
            </div>
          );
        })}
    </>
  );
}
