"use client";

import {
  ImageIcon,
  Terminal,
  Search,
  FileText,
  FilePlus,
  FilePen,
  FileMinus,
  FileOutput,
  Code2,
  FileIcon,
  ListTodo,
  NotebookPen,
  FolderSearch,
  FileDown,
  ExternalLink,
  Globe,
  WandSparkles,
} from "lucide-react";
import {
  getNotesIcon,
  getNotesActionText,
  getNotesActionType,
  type NotesToolName,
} from "@/app/components/tools/notes-tool-utils";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
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
  getShellActionLabel,
  getShellDisplayCommand,
  getShellDisplayTarget,
  getShellOutput,
  type ShellToolInput,
  type ShellToolOutput,
} from "@/app/components/tools/shell-tool-utils";

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

interface SharedMessagePartHandlerProps {
  part: MessagePart;
  partIndex: number;
  isUser: boolean;
  allParts?: MessagePart[];
}

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

  // Terminal commands
  if (
    part.type === "data-terminal" ||
    part.type === "tool-shell" ||
    part.type === "tool-run_terminal_cmd"
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

  // Python execution
  if (part.type === "data-python" || part.type === "tool-python") {
    return renderPythonTool(part, idx, openSidebar);
  }

  // Web search
  if (part.type === "tool-web_search" || part.type === "tool-web") {
    return renderWebSearchTool(part, idx);
  }

  // Open URL
  if (part.type === "tool-open_url") {
    return renderOpenUrlTool(part, idx);
  }

  // Match tool (glob/grep)
  if (part.type === "tool-match") {
    return renderMatchTool(part, idx, openSidebar);
  }

  // Get terminal files
  if (part.type === "tool-get_terminal_files") {
    return renderGetTerminalFilesTool(part, idx);
  }

  // Todo operations
  if (part.type === "tool-todo_write") {
    return renderTodoTool(part, idx);
  }

  // Memory operations
  if (part.type === "tool-update_memory") {
    return renderMemoryTool(part, idx);
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

  return null;
};

// Terminal tool renderer
function renderTerminalTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const terminalInput = part.input as ShellToolInput;
  const terminalOutput = part.output as ShellToolOutput;
  const command = getShellDisplayCommand(terminalInput);
  const target = getShellDisplayTarget(terminalInput);
  const output = getShellOutput(terminalOutput);

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

    const isShellTool = part.type === "tool-shell";
    const actionLabel = getShellActionLabel({
      isShellTool,
      action: terminalInput?.action,
      pid: terminalInput?.pid ?? terminalOutput?.pid,
    });

    return (
      <ToolBlock
        key={idx}
        icon={<Terminal aria-hidden="true" />}
        action={actionLabel}
        target={target}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
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
    action = "Successfully wrote";
    icon = <FilePlus aria-hidden="true" />;
    sidebarAction = "writing";
  }
  if (part.type === "tool-delete_file") {
    action = "Successfully deleted";
    icon = <FileMinus aria-hidden="true" />;
  }
  if (part.type === "tool-search_replace" || part.type === "tool-multi_edit") {
    action = "Successfully edited";
    icon = <FilePen aria-hidden="true" />;
    sidebarAction = "editing";
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
    action?: "read" | "write" | "append" | "edit";
    path?: string;
    text?: string;
    range?: [number, number];
  };
  const fileOutput = part.output as {
    originalContent?: string;
    modifiedContent?: string;
    error?: string;
  };
  const filePath = fileInput?.path || "";
  const fileAction = fileInput?.action || "read";

  const getFileRange = () => {
    if (!fileInput?.range) return "";
    const [start, end] = fileInput.range;
    if (end === -1) return ` L${start}+`;
    return ` L${start}-${end}`;
  };

  let action = "Read";
  let icon = <FileText aria-hidden="true" />;
  let sidebarAction:
    | "reading"
    | "creating"
    | "editing"
    | "writing"
    | "appending" = "reading";

  if (fileAction === "read") {
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

  if (fileOutput?.error) {
    action = `Failed to ${fileAction}`;
  }

  if (part.state === "output-available") {
    const handleOpenInSidebar = () => {
      let content = "";
      if (fileAction === "read") {
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
        target={`${filePath}${getFileRange()}`}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}

// Python tool renderer
function renderPythonTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const pythonInput = part.input as { code?: string };
  const pythonOutput = part.output as { result?: string; output?: string };
  const code = pythonInput?.code || "";
  const output = pythonOutput?.result || pythonOutput?.output || "";
  const codePreview = code.split("\n")[0]?.substring(0, 50);

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
        icon={<Code2 aria-hidden="true" />}
        action="Executed Python"
        target={codePreview}
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
  };

  let target: string | undefined;
  if (webInput?.queries && webInput.queries.length > 0) {
    target = webInput.queries.join(", ");
  } else if (webInput?.query) {
    target = webInput.query;
  } else if (webInput?.url) {
    target = webInput.url;
  }

  if (part.state === "output-available") {
    return (
      <ToolBlock
        key={idx}
        icon={<Search aria-hidden="true" />}
        action="Searched web"
        target={target}
      />
    );
  }
  return null;
}

// Open URL tool renderer
function renderOpenUrlTool(part: MessagePart, idx: number) {
  const urlInput = part.input as { url?: string };

  if (part.state === "output-available") {
    return (
      <ToolBlock
        key={idx}
        icon={<ExternalLink aria-hidden="true" />}
        action="Opened URL"
        target={urlInput?.url}
      />
    );
  }
  return null;
}

// Match tool renderer (glob/grep)
function renderMatchTool(
  part: MessagePart,
  idx: number,
  openSidebar: ReturnType<typeof useSharedChatContext>["openSidebar"],
) {
  const matchInput = part.input as {
    action?: "glob" | "grep";
    scope?: string;
    regex?: string;
  };
  const matchOutput = part.output as { output?: string };
  const isGlob = matchInput?.action === "glob";

  const getTarget = () => {
    if (!matchInput?.scope) return undefined;
    if (!isGlob && matchInput.regex) {
      return `"${matchInput.regex}" in ${matchInput.scope}`;
    }
    return matchInput.scope;
  };

  const getResultLabel = (outputText: string) => {
    if (outputText.startsWith("Found ")) {
      const match = outputText.match(/^Found (\d+) (file|match)/);
      if (match) {
        const count = parseInt(match[1], 10);
        const type = match[2];
        if (type === "file") {
          return `Found ${count} file${count === 1 ? "" : "s"}`;
        }
        return `Found ${count} match${count === 1 ? "" : "es"}`;
      }
    }
    if (outputText.startsWith("No files found")) return "No files found";
    if (outputText.startsWith("No matches found")) return "No matches found";
    return "Search complete";
  };

  if (part.state === "output-available") {
    const outputText = matchOutput?.output || "";

    const handleOpenInSidebar = () => {
      openSidebar({
        path: matchInput?.scope || "",
        content: outputText || "No results",
        action: "searching",
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
        icon={<FolderSearch aria-hidden="true" />}
        action={getResultLabel(outputText)}
        target={getTarget()}
        isClickable={true}
        onClick={handleOpenInSidebar}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return null;
}

// Get terminal files tool renderer
function renderGetTerminalFilesTool(part: MessagePart, idx: number) {
  const filesInput = part.input as { files?: string[] };
  const filesOutput = part.output as {
    files?: Array<{ path: string }>;
    fileUrls?: Array<{ path: string }>;
  };

  const getFileNames = (paths: string[]) => {
    return paths.map((path) => path.split("/").pop() || path).join(", ");
  };

  if (part.state === "output-available") {
    const fileCount =
      filesOutput?.files?.length || filesOutput?.fileUrls?.length || 0;
    const fileNames = getFileNames(filesInput?.files || []);

    return (
      <ToolBlock
        key={idx}
        icon={<FileDown aria-hidden="true" />}
        action={`Shared ${fileCount} file${fileCount !== 1 ? "s" : ""}`}
        target={fileNames}
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
      return (
        <SharedTodoBlock
          key={idx}
          todos={todoOutput.currentTodos}
          blockId={part.toolCallId || `todo-${idx}`}
        />
      );
    }

    return (
      <ToolBlock
        key={idx}
        icon={<ListTodo aria-hidden="true" />}
        action="Updated todos"
      />
    );
  }
  return null;
}

// Memory tool renderer
function renderMemoryTool(part: MessagePart, idx: number) {
  const memoryInput = part.input as {
    action?: "create" | "update" | "delete";
    title?: string;
  };

  const getActionText = (action?: string) => {
    switch (action) {
      case "create":
        return "Created memory";
      case "update":
        return "Updated memory";
      case "delete":
        return "Deleted memory";
      default:
        return "Updated memory";
    }
  };

  if (part.state === "output-available") {
    return (
      <ToolBlock
        key={idx}
        icon={<NotebookPen aria-hidden="true" />}
        action={getActionText(memoryInput?.action)}
        target={memoryInput?.title}
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
    <div key={idx} className="mb-3 flex items-center gap-2">
      <WandSparkles
        className="w-4 h-4 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="text-sm text-muted-foreground">{data?.message}</span>
    </div>
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
    if (httpOutput?.error) return "Request failed";
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
        output: httpOutput?.output || httpOutput?.error || "",
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
    | "general"
    | "findings"
    | "methodology"
    | "questions"
    | "plan";

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
