"use client";

import {
  ImageIcon,
  Eye,
  Terminal,
  Radar,
  Search,
  FileText,
  FilePlus,
  FilePen,
  FileMinus,
  FileOutput,
  FileIcon,
  ListTodo,
  FileDown,
  ExternalLink,
  Globe,
} from "lucide-react";
import {
  getNotesIcon,
  getNotesActionText,
  getNotesActionType,
  type NotesToolName,
} from "@/app/components/tools/notes-tool-utils";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { SummarizationStatusDivider } from "@/app/components/SummarizationStatusDivider";
import ToolBlock from "@/components/ui/tool-block";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { useSharedChatContext } from "../SharedChatContext";
import { SharedTodoBlock } from "./SharedTodoBlock";
import type { Todo } from "@/types";
import {
  computeShellTerminalBlock,
  getTerminalFailureAction,
  type ShellToolInput,
  type ShellToolOutput,
} from "@/app/components/tools/shell-tool-utils";
import { PROXY_COMPLETED_LABELS } from "@/app/components/tools/ProxyToolHandler";
import { isUserStoppedToolError } from "@/lib/chat/tool-abort-utils";
import { FindingCard } from "@/app/components/findings/FindingCard";
import { ToolErrorBlock } from "@/app/components/tools/ToolErrorHandler";
import {
  createToolInputErrorContent,
  isToolInputValidationError,
} from "@/lib/chat/tool-error-display";

interface MessagePart {
  type: string;
  text?: string;
  placeholder?: boolean;
  state?: string;
  input?: any;
  output?: any;
  toolCallId?: string;
  toolName?: string;
  errorText?: string;
  data?: any;
}

interface SharedMessagePartHandlerProps {
  part: MessagePart;
  partIndex: number;
  isUser: boolean;
  allParts?: MessagePart[];
}

const isStoppedToolPart = (part: MessagePart) =>
  isUserStoppedToolError(part.errorText);

export const SharedMessagePartHandler = ({
  part,
  partIndex: idx,
  isUser,
  allParts = [],
}: SharedMessagePartHandlerProps) => {
  const { openSidebar } = useSharedChatContext();

  // Text content
  if (part.type === "text" && part.text) {
    return (
      <div key={idx}>
        {isUser ? part.text : <MemoizedMarkdown content={part.text} />}
      </div>
    );
  }

  // Reasoning content
  if (part.type === "reasoning") {
    return renderReasoningPart(allParts, idx);
  }

  // Summarization status
  if (part.type === "data-summarization") {
    return renderSummarizationPart(part, idx);
  }

  // File/Image placeholder - simple indicator style
  if ((part.type === "file" || part.type === "image") && part.placeholder) {
    const isImage = part.type === "image";
    return (
      <div key={idx} className="flex gap-2 flex-wrap mt-1 w-full justify-end">
        <div className="text-muted-foreground flex items-center gap-2 whitespace-nowrap">
          {isImage ? (
            <ImageIcon className="w-5 h-5" aria-hidden="true" />
          ) : (
            <FileIcon className="w-5 h-5" aria-hidden="true" />
          )}
          <span>{isImage ? "Uploaded an image" : "Uploaded a file"}</span>
        </div>
      </div>
    );
  }

  if (part.type === "data-shared-finding" && part.data) {
    return (
      <FindingCard
        title={part.data.title}
        target={part.data.target}
        severity={part.data.severity}
        cvssScore={part.data.cvss_score}
      />
    );
  }

  const validationToolType = part.type.startsWith("tool-")
    ? part.type
    : part.type === "dynamic-tool" && typeof part.toolName === "string"
      ? `tool-${part.toolName}`
      : null;
  if (
    validationToolType &&
    part.state === "output-error" &&
    isToolInputValidationError(part.errorText)
  ) {
    const content = createToolInputErrorContent({
      toolType: validationToolType,
      toolCallId: part.toolCallId || "",
      errorText: part.errorText,
    });
    return (
      <ToolErrorBlock content={content} onOpen={() => openSidebar(content)} />
    );
  }

  // Terminal commands
  if (
    part.type === "data-terminal" ||
    part.type === "tool-shell" ||
    part.type === "tool-run_terminal_cmd" ||
    part.type === "tool-interact_terminal_session"
  ) {
    return renderTerminalTool(part, idx, openSidebar);
  }

  // Legacy file operations
  if (
    part.type === "tool-read_file" ||
    part.type === "tool-write_file" ||
    part.type === "tool-delete_file" ||
    part.type === "tool-search_replace" ||
    part.type === "tool-multi_edit"
  ) {
    return renderLegacyFileTool(part, idx, openSidebar);
  }

  // New unified file tool
  if (part.type === "tool-file") {
    return renderFileTool(part, idx, openSidebar);
  }

  // Web search
  if (part.type === "tool-web_search" || part.type === "tool-web") {
    return renderWebSearchTool(part, idx);
  }

  // Open URL
  if (part.type === "tool-open_url") {
    return renderOpenUrlTool(part, idx);
  }

  // Get terminal files
  if (part.type === "tool-get_terminal_files") {
    return renderGetTerminalFilesTool(part, idx);
  }

  // Todo operations
  if (part.type === "tool-todo_write") {
    return renderTodoTool(part, idx);
  }

  // HTTP request (legacy)
  if (part.type === "tool-http_request") {
    return renderHttpRequestTool(part, idx, openSidebar);
  }

  // Notes operations
  if (
    part.type === "tool-create_note" ||
    part.type === "tool-list_notes" ||
    part.type === "tool-update_note" ||
    part.type === "tool-delete_note"
  ) {
    return renderNotesTool(part, idx, openSidebar);
  }

  // Proxy tools
  if (
    part.type === "tool-list_requests" ||
    part.type === "tool-view_request" ||
    part.type === "tool-send_request" ||
    part.type === "tool-scope_rules" ||
    part.type === "tool-list_sitemap" ||
    part.type === "tool-view_sitemap_entry"
  ) {
    return renderProxyTool(part, idx, openSidebar);
  }

  return null;
};

// Terminal tool renderer
function renderTerminalTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  if (
    part.state !== "input-available" &&
    part.state !== "output-available" &&
    part.state !== "output-error"
  ) {
    return null;
  }

  const isShellTool =
    part.type === "tool-shell" ||
    (part.input as { action?: string } | undefined)?.action !== undefined;
  const legacyInput = !isShellTool
    ? (part.input as {
        command?: string;
        interactive?: boolean;
        is_background?: boolean;
      })
    : undefined;

  const { blockAction, blockTarget, sidebarContent } =
    computeShellTerminalBlock({
      isShellTool,
      shellInput: part.input as ShellToolInput | undefined,
      shellOutput: part.output as ShellToolOutput | undefined,
      errorText: part.errorText,
      streamingOutput: "",
      isExecuting: false,
      hasResult: part.state === "output-available",
      toolCallId: part.toolCallId || "",
      legacyInteractive: legacyInput?.interactive,
      legacyIsBackground: legacyInput?.is_background,
      legacyCommand: legacyInput?.command,
    });

  const handleOpenInSidebar = () => {
    if (sidebarContent) openSidebar(sidebarContent);
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
      icon={<Terminal aria-hidden="true" />}
      action={
        part.state === "output-error"
          ? isStoppedToolPart(part)
            ? "Stopped command"
            : getTerminalFailureAction(part.errorText)
          : blockAction(false)
      }
      target={blockTarget}
      isClickable={!!sidebarContent}
      onClick={sidebarContent ? handleOpenInSidebar : undefined}
      onKeyDown={sidebarContent ? handleKeyDown : undefined}
    />
  );
}

// Legacy file tools renderer
function renderLegacyFileTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const fileInput = part.input as {
    file_path?: string;
    path?: string;
    target_file?: string;
    offset?: number;
    limit?: number;
    content?: string;
    contents?: string;
  };
  const fileOutput = part.output as { result?: string };
  const filePath =
    fileInput?.file_path || fileInput?.path || fileInput?.target_file || "";

  let action = "File operation";
  let icon = <FileText aria-hidden="true" />;
  let sidebarAction: "reading" | "creating" | "editing" | "writing" = "reading";

  if (part.type === "tool-read_file") {
    action = "Read";
    icon = <FileText aria-hidden="true" />;
    sidebarAction = "reading";
  }
  if (part.type === "tool-write_file") {
    action =
      part.state === "output-error"
        ? isStoppedToolPart(part)
          ? "Stopped writing"
          : "Failed to write"
        : "Successfully wrote";
    icon = <FilePlus aria-hidden="true" />;
    sidebarAction = "writing";
  }
  if (part.type === "tool-delete_file") {
    action =
      part.state === "output-error"
        ? isStoppedToolPart(part)
          ? "Stopped deleting"
          : "Failed to delete"
        : "Successfully deleted";
    icon = <FileMinus aria-hidden="true" />;
  }
  if (part.type === "tool-search_replace" || part.type === "tool-multi_edit") {
    action =
      part.state === "output-error"
        ? isStoppedToolPart(part)
          ? "Stopped editing"
          : "Failed to edit"
        : "Successfully edited";
    icon = <FilePen aria-hidden="true" />;
    sidebarAction = "editing";
  }
  if (part.type === "tool-read_file" && part.state === "output-error") {
    action = isStoppedToolPart(part) ? "Stopped reading" : "Failed to read";
  }

  if (part.state === "output-error") {
    return (
      <ToolBlock key={idx} icon={icon} action={action} target={filePath} />
    );
  }

  if (part.state === "output-available") {
    // For delete operations, don't make it clickable
    if (part.type === "tool-delete_file") {
      return (
        <ToolBlock key={idx} icon={icon} action={action} target={filePath} />
      );
    }

    const handleOpenInSidebar = () => {
      let content = "";
      if (part.type === "tool-read_file") {
        content = (fileOutput?.result || "").replace(/^\s*\d+\|/gm, "");
      } else if (part.type === "tool-write_file") {
        content = fileInput?.contents || fileInput?.content || "";
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
  return null;
}

// New unified file tool renderer
function renderFileTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const fileInput = part.input as {
    action?: "view" | "read" | "write" | "append" | "edit";
    path?: string;
    text?: string;
    range?: [number, number];
    brief?: string;
  };
  const fileOutput = part.output as {
    content?: string;
    filename?: string;
    mediaType?: string;
    sizeBytes?: number;
    kind?: "image" | "pdf";
    previewFiles?: Array<{
      fileId?: any;
      name?: string;
      filename?: string;
      mediaType?: string;
      s3Key?: string;
      page?: number;
    }>;
    renderedPages?: number[];
    renderedPageLimit?: number;
    truncatedPages?: boolean;
    pageCount?: number;
    previewError?: string;
    originalContent?: string;
    modifiedContent?: string;
    error?: string;
  };
  const filePath = fileInput?.path || "";
  const fileAction = fileInput?.action || "read";
  const brief = fileInput?.brief?.trim() || "";

  const getFileRange = () => {
    if (!fileInput?.range) return "";
    const [start, end] = fileInput.range;
    if (end === -1) return ` L${start}+`;
    return ` L${start}-${end}`;
  };

  let action = "Read";
  let icon = <FileText aria-hidden="true" />;
  let sidebarAction:
    "reading" | "viewing" | "creating" | "editing" | "writing" | "appending" =
    "reading";

  if (fileAction === "view") {
    action = "Viewed";
    icon = <Eye aria-hidden="true" />;
    sidebarAction = "viewing";
  } else if (fileAction === "read") {
    action = "Read";
    icon = <FileText aria-hidden="true" />;
    sidebarAction = "reading";
  } else if (fileAction === "write") {
    action = "Successfully wrote";
    icon = <FilePlus aria-hidden="true" />;
    sidebarAction = "writing";
  } else if (fileAction === "append") {
    action = "Successfully appended to";
    icon = <FileOutput aria-hidden="true" />;
    sidebarAction = "appending";
  } else if (fileAction === "edit") {
    action = "Edited";
    icon = <FilePen aria-hidden="true" />;
    sidebarAction = "editing";
  }

  const isError = part.state === "output-error" || !!fileOutput?.error;
  if (isError) {
    if (isStoppedToolPart(part)) {
      if (fileAction === "read") action = "Stopped reading";
      if (fileAction === "write") action = "Stopped writing";
      if (fileAction === "append") action = "Stopped appending to";
      if (fileAction === "edit") action = "Stopped editing";
    } else {
      action = `Failed to ${fileAction}`;
    }
  }

  // Mirror the live FileHandler: when the model supplies a `brief` and the
  // call didn't error, the brief stands alone as the block label.
  const useBriefOnly = !!brief && !isError;

  if (part.state === "output-error") {
    return (
      <ToolBlock
        key={idx}
        icon={icon}
        action={action}
        target={`${filePath}${getFileRange()}`}
      />
    );
  }

  if (part.state === "output-available") {
    const handleOpenInSidebar = () => {
      let content = "";
      if (fileAction === "view") {
        content = fileOutput?.content || "";
      } else if (fileAction === "read") {
        content = fileOutput?.originalContent || "";
      } else if (fileAction === "write" || fileAction === "append") {
        content = fileInput?.text || "";
      } else {
        content = fileOutput?.modifiedContent || "";
      }

      const range = fileInput?.range
        ? {
            start: fileInput.range[0],
            end: fileInput.range[1] === -1 ? undefined : fileInput.range[1],
          }
        : undefined;

      openSidebar({
        path: filePath,
        content,
        range,
        action: sidebarAction,
        filename: fileOutput?.filename,
        mediaType: fileOutput?.mediaType,
        sizeBytes: fileOutput?.sizeBytes,
        kind: fileOutput?.kind,
        previewFiles: fileOutput?.previewFiles,
        renderedPages: fileOutput?.renderedPages,
        renderedPageLimit: fileOutput?.renderedPageLimit,
        truncatedPages: fileOutput?.truncatedPages,
        pageCount: fileOutput?.pageCount,
        previewError: fileOutput?.previewError,
        error: fileOutput?.error,
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
        action={useBriefOnly ? brief : action}
        target={useBriefOnly ? undefined : `${filePath}${getFileRange()}`}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}

// Web search tool renderer
function renderWebSearchTool(part: MessagePart, idx: number) {
  const webInput = part.input as {
    queries?: string[];
    query?: string;
    url?: string;
    brief?: string;
  };

  let target: string | undefined;
  if (webInput?.queries && webInput.queries.length > 0) {
    target = webInput.queries.join(", ");
  } else if (webInput?.query) {
    target = webInput.query;
  } else if (webInput?.url) {
    target = webInput.url;
  }

  const brief = webInput?.brief?.trim() || "";

  if (part.state === "output-error") {
    return (
      <ToolBlock
        key={idx}
        icon={<Search aria-hidden="true" />}
        action={
          isStoppedToolPart(part) ? "Stopped searching web" : "Search failed"
        }
        target={target}
      />
    );
  }

  if (part.state === "output-available") {
    return (
      <ToolBlock
        key={idx}
        icon={<Search aria-hidden="true" />}
        action={brief || "Searched web"}
        target={brief ? undefined : target}
      />
    );
  }
  return null;
}

// Open URL tool renderer
function renderOpenUrlTool(part: MessagePart, idx: number) {
  const urlInput = part.input as { url?: string; brief?: string };
  const brief = urlInput?.brief?.trim() || "";

  if (part.state === "output-error") {
    return (
      <ToolBlock
        key={idx}
        icon={<ExternalLink aria-hidden="true" />}
        action={
          isStoppedToolPart(part) ? "Stopped opening URL" : "Failed to open URL"
        }
        target={urlInput?.url}
      />
    );
  }

  if (part.state === "output-available") {
    return (
      <ToolBlock
        key={idx}
        icon={<ExternalLink aria-hidden="true" />}
        action={brief || "Opened URL"}
        target={brief ? undefined : urlInput?.url}
      />
    );
  }
  return null;
}

// Get terminal files tool renderer
function renderGetTerminalFilesTool(part: MessagePart, idx: number) {
  const filesInput = part.input as { files?: string[]; brief?: string };
  const filesOutput = part.output as {
    files?: Array<{ path: string }>;
    failedFiles?: Array<{ path: string; reason?: string }>;
    fileUrls?: Array<{ path: string }>;
  };

  const getFileNames = (paths: string[]) => {
    return paths.map((path) => path.split("/").pop() || path).join(", ");
  };

  const fileNames = getFileNames(filesInput?.files || []);
  const brief = filesInput?.brief?.trim() || "";

  if (part.state === "output-error") {
    return (
      <ToolBlock
        key={idx}
        icon={<FileDown aria-hidden="true" />}
        action={isStoppedToolPart(part) ? "Stopped sharing" : "Failed to share"}
        target={fileNames}
      />
    );
  }

  if (part.state === "output-available") {
    const successfulPaths = [
      ...(filesOutput?.files?.map((file) => file.path) || []),
      ...(filesOutput?.fileUrls?.map((file) => file.path) || []),
    ];
    const fileCount = successfulPaths.length;
    const failedFileCount = filesOutput?.failedFiles?.length || 0;
    const totalFileCount = fileCount + failedFileCount;
    const displayPaths =
      fileCount > 0 ? successfulPaths : filesInput?.files || [];
    const displayFileNames = getFileNames(displayPaths);
    const fallbackAction =
      failedFileCount > 0
        ? fileCount > 0
          ? `Shared ${fileCount} of ${totalFileCount} files`
          : "Failed to share"
        : `Shared ${fileCount} file${fileCount !== 1 ? "s" : ""}`;

    return (
      <ToolBlock
        key={idx}
        icon={<FileDown aria-hidden="true" />}
        action={failedFileCount === 0 && brief ? brief : fallbackAction}
        target={failedFileCount === 0 && brief ? undefined : displayFileNames}
      />
    );
  }
  return null;
}

// Todo tool renderer
function renderTodoTool(part: MessagePart, idx: number) {
  if (part.state === "output-available") {
    const todoOutput = part.output as {
      currentTodos?: Todo[];
      counts?: { completed: number; total: number };
    };

    if (todoOutput?.currentTodos && todoOutput.currentTodos.length > 0) {
      return <SharedTodoBlock key={idx} todos={todoOutput.currentTodos} />;
    }

    return (
      <ToolBlock
        key={idx}
        icon={<ListTodo aria-hidden="true" />}
        action="Updated todos"
      />
    );
  }
  if (part.state === "output-error") {
    const todoInput = part.input as { merge?: boolean; todos?: unknown[] };
    const stoppedTodoAction = todoInput?.merge
      ? "Stopped updating to-do list"
      : "Stopped creating to-do list";
    const failedTodoAction = todoInput?.merge
      ? "Todo update failed"
      : "Todo creation failed";
    return (
      <ToolBlock
        key={idx}
        icon={<ListTodo aria-hidden="true" />}
        action={isStoppedToolPart(part) ? stoppedTodoAction : failedTodoAction}
        target={
          todoInput?.todos?.length
            ? `${todoInput.todos.length} items`
            : undefined
        }
      />
    );
  }
  return null;
}

// Proxy tool renderer
function renderProxyTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const toolName = part.type.replace("tool-", "");
  const proxyInput = part.input || {};

  const getDisplayTarget = (): string => {
    switch (toolName) {
      case "send_request":
        return proxyInput.method && proxyInput.url
          ? `${proxyInput.method} ${proxyInput.url}`
          : "";
      case "view_request":
        return proxyInput.request_id ? `Request ${proxyInput.request_id}` : "";
      case "list_requests":
        return proxyInput.httpql_filter || "";
      case "scope_rules":
        return proxyInput.action || "";
      case "view_sitemap_entry":
        return proxyInput.entry_id ? `Entry ${proxyInput.entry_id}` : "";
      default:
        return proxyInput.explanation || "";
    }
  };

  const getDisplayCommand = (): string => {
    const parts: string[] = [toolName];
    if (proxyInput.request_id) parts.push(`id:${proxyInput.request_id}`);
    if (proxyInput.method && proxyInput.url)
      parts.push(`${proxyInput.method} ${proxyInput.url}`);
    if (proxyInput.httpql_filter)
      parts.push(`filter:"${proxyInput.httpql_filter}"`);
    if (proxyInput.action) parts.push(proxyInput.action);
    if (proxyInput.entry_id) parts.push(`entry:${proxyInput.entry_id}`);
    return parts.join(" ");
  };

  const getOutput = (): string => {
    if (part.errorText) return `Error: ${part.errorText}`;
    if (part.output?.result?.error) return `Error: ${part.output.result.error}`;
    if (part.output?.result) {
      try {
        return JSON.stringify(part.output.result, null, 2);
      } catch {
        return String(part.output.result);
      }
    }
    return "";
  };

  const isError =
    part.state === "output-error" ||
    !!part.errorText ||
    !!part.output?.result?.error;
  const actionText = isError
    ? isStoppedToolPart(part)
      ? "Stopped proxy action"
      : "Proxy action failed"
    : PROXY_COMPLETED_LABELS[toolName] || "Executed";

  if (
    part.state === "input-available" ||
    part.state === "output-available" ||
    part.state === "output-error"
  ) {
    const handleOpenInSidebar = () => {
      openSidebar({
        proxyAction: toolName,
        command: getDisplayCommand(),
        output: getOutput(),
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
        icon={<Radar aria-hidden="true" />}
        action={actionText}
        target={getDisplayTarget()}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}

// Reasoning part renderer
function renderReasoningPart(parts: MessagePart[], partIndex: number) {
  // Skip if previous part is also reasoning (avoid duplicate renders)
  const previousPart = parts[partIndex - 1];
  if (previousPart?.type === "reasoning") return null;

  // Collect all consecutive reasoning parts
  const collectReasoningText = (startIndex: number): string => {
    const collected: string[] = [];
    for (let i = startIndex; i < parts.length; i++) {
      const p = parts[i];
      if (p?.type === "reasoning") {
        collected.push(p.text ?? "");
      } else {
        break;
      }
    }
    return collected.join("");
  };

  const combined = collectReasoningText(partIndex);

  // Don't show reasoning if empty or only contains [REDACTED]
  if (!combined || /^(\[REDACTED\])+$/.test(combined.trim())) return null;

  return (
    <Reasoning key={partIndex} className="w-full">
      <ReasoningTrigger />
      {combined && (
        <ReasoningContent>
          <MemoizedMarkdown content={combined} />
        </ReasoningContent>
      )}
    </Reasoning>
  );
}

// Summarization status renderer
function renderSummarizationPart(part: MessagePart, idx: number) {
  const data = (part as any).data as { status?: string; message?: string };

  return (
    <SummarizationStatusDivider
      key={idx}
      status={data?.status}
      message={data?.message}
    />
  );
}

// HTTP request tool renderer (legacy)
function renderHttpRequestTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const httpInput = part.input as {
    url?: string;
    method?: string;
  };
  const httpOutput = part.output as {
    output?: string;
    error?: string;
  };

  const displayCommand = httpInput?.url
    ? `${httpInput.method || "GET"} ${httpInput.url}`
    : "";

  const getActionText = () => {
    if (part.state === "output-error" || httpOutput?.error || part.errorText) {
      return isStoppedToolPart(part) ? "Stopped request" : "Request failed";
    }
    return "Requested";
  };

  if (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "input-available"
  ) {
    const handleOpenInSidebar = () => {
      openSidebar({
        command: displayCommand,
        output: httpOutput?.output || httpOutput?.error || part.errorText || "",
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
        icon={<Globe aria-hidden="true" />}
        action={getActionText()}
        target={displayCommand}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}

// Notes tool renderer
function renderNotesTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const notesInput = part.input as {
    title?: string;
    content?: string;
    note_id?: string;
    category?: string;
    tags?: string[];
    search?: string;
  };
  type NoteCategory =
    "general" | "findings" | "methodology" | "questions" | "plan";

  const notesOutput = part.output as {
    success?: boolean;
    error?: string;
    note_id?: string;
    notes?: Array<{
      note_id: string;
      title: string;
      content: string;
      category: NoteCategory;
      tags: string[];
      _creationTime: number;
      updated_at: number;
    }>;
    total_count?: number;
    deleted_title?: string;
    original?: {
      title: string;
      content: string;
      category: string;
      tags: string[];
    };
    modified?: {
      title: string;
      content: string;
      category: string;
      tags: string[];
    };
  };

  const getToolName = (): NotesToolName => {
    if (part.type === "tool-create_note") return "create_note";
    if (part.type === "tool-list_notes") return "list_notes";
    if (part.type === "tool-update_note") return "update_note";
    if (part.type === "tool-delete_note") return "delete_note";
    return "create_note";
  };

  const toolName = getToolName();

  const getTarget = () => {
    if (toolName === "create_note" && notesInput?.title) {
      return notesInput.title;
    }
    if (toolName === "update_note") {
      // Prefer modified title, then input title, then note_id
      return (
        notesOutput?.modified?.title || notesInput?.title || notesInput?.note_id
      );
    }
    if (toolName === "delete_note") {
      // Prefer deleted_title from output, then note_id
      return notesOutput?.deleted_title || notesInput?.note_id;
    }
    if (toolName === "list_notes") {
      const filters: string[] = [];
      if (notesInput?.category) filters.push(notesInput.category);
      if (notesInput?.tags?.length)
        filters.push(`tagged: ${notesInput.tags.join(", ")}`);
      if (notesInput?.search) filters.push(`"${notesInput.search}"`);
      return filters.length > 0 ? filters.join(" · ") : undefined;
    }
    return undefined;
  };

  if (part.state === "output-error") {
    return (
      <ToolBlock
        key={idx}
        icon={getNotesIcon(toolName)}
        action={
          isStoppedToolPart(part)
            ? "Stopped note action"
            : getNotesActionText(toolName, true)
        }
        target={getTarget()}
      />
    );
  }

  if (part.state === "output-available") {
    // Check for failure state
    const isFailure = notesOutput?.success === false;

    if (isFailure) {
      // For failures, show error message in target and don't make clickable
      return (
        <ToolBlock
          key={idx}
          icon={getNotesIcon(toolName)}
          action={getNotesActionText(toolName, true)}
          target={notesOutput?.error}
        />
      );
    }

    const action = getNotesActionType(toolName);
    let notes: Array<{
      note_id: string;
      title: string;
      content: string;
      category: NoteCategory;
      tags: string[];
      _creationTime: number;
      updated_at: number;
    }> = [];
    let totalCount = 0;
    let affectedTitle: string | undefined;
    let newNoteId: string | undefined;
    let original: typeof notesOutput.original;
    let modified: typeof notesOutput.modified;

    if (action === "list" && notesOutput?.notes) {
      notes = notesOutput.notes;
      totalCount = notesOutput.total_count || notes.length;
    } else if (action === "create" && notesInput) {
      notes = [
        {
          note_id: notesOutput?.note_id || "pending",
          title: notesInput.title || "",
          content: notesInput.content || "",
          category: (notesInput.category as NoteCategory) || "general",
          tags: notesInput.tags || [],
          _creationTime: Date.now(),
          updated_at: Date.now(),
        },
      ];
      totalCount = 1;
      affectedTitle = notesInput.title;
      newNoteId = notesOutput?.note_id;
    } else if (action === "update") {
      // For update, use original/modified for before/after comparison
      original = notesOutput?.original;
      modified = notesOutput?.modified;
      affectedTitle =
        modified?.title || notesInput?.title || notesInput?.note_id;
      totalCount = 1;
    } else if (action === "delete") {
      affectedTitle = notesOutput?.deleted_title || notesInput?.note_id;
      totalCount = 0;
    }

    const handleOpenInSidebar = () => {
      openSidebar({
        action,
        notes,
        totalCount,
        isExecuting: false,
        toolCallId: part.toolCallId || "",
        affectedTitle,
        newNoteId,
        original,
        modified,
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
        icon={getNotesIcon(toolName)}
        action={getNotesActionText(toolName)}
        target={getTarget()}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}
