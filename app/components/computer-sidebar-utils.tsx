import React from "react";
import {
  Edit,
  Terminal,
  Search,
  FolderSearch,
  StickyNote,
  FileDown,
  Radar,
} from "lucide-react";
import {
  isSidebarFile,
  isSidebarTerminal,
  isSidebarProxy,
  isSidebarWebSearch,
  isSidebarNotes,
  isSidebarSharedFiles,
  type SidebarContent,
  type NoteCategory,
} from "@/types/chat";
import {
  getShellActionLabel,
  formatSendInput,
  isInteractiveShellAction,
} from "./tools/shell-tool-utils";
import {
  PROXY_ACTION_LABELS,
  PROXY_COMPLETED_LABELS,
} from "./tools/ProxyToolHandler";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function getCategoryColor(category: NoteCategory): string {
  switch (category) {
    case "findings":
      return "text-red-500";
    case "methodology":
      return "text-blue-500";
    case "questions":
      return "text-yellow-500";
    case "plan":
      return "text-green-500";
    default:
      return "text-muted-foreground";
  }
}

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  sass: "sass",
  html: "html",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  clj: "clojure",
  hs: "haskell",
  elm: "elm",
  vue: "vue",
  svelte: "svelte",
};

export function getLanguageFromPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() || "";
  return LANGUAGE_MAP[extension] || "text";
}

// ---------------------------------------------------------------------------
// Sidebar metadata helpers (action text, icon, tool name, display target)
// ---------------------------------------------------------------------------

export function getActionText(content: SidebarContent): string {
  if (isSidebarFile(content)) {
    if (content.isExecuting) {
      const streamingActionMap = {
        reading: "Reading",
        creating: "Creating",
        editing: "Editing",
        writing: "Writing to",
        searching: "Searching",
        appending: "Appending to",
      };
      return streamingActionMap[content.action || "reading"];
    }
    const completedActionMap = {
      reading: "Read",
      creating: "Successfully wrote",
      editing: "Successfully edited",
      writing: "Successfully wrote",
      searching: "Search results",
      appending: "Successfully appended to",
    };
    return completedActionMap[content.action || "reading"];
  }

  if (isSidebarProxy(content)) {
    if (content.isExecuting) {
      return PROXY_ACTION_LABELS[content.proxyAction] || "Proxying";
    }
    return PROXY_COMPLETED_LABELS[content.proxyAction] || "Executed";
  }

  if (isSidebarTerminal(content)) {
    return getShellActionLabel({
      isShellTool: !!content.shellAction,
      action: content.shellAction,
      isActive: content.isExecuting,
      interactive: content.isInteractive,
      isBackground: content.isBackground,
    });
  }

  if (isSidebarWebSearch(content)) {
    return content.isSearching ? "Searching web" : "Search results";
  }

  if (isSidebarNotes(content)) {
    if (content.isExecuting) {
      const streamingActionMap = {
        create: "Creating note",
        list: "Listing notes",
        update: "Updating note",
        delete: "Deleting note",
      };
      return streamingActionMap[content.action];
    }
    const completedActionMap = {
      create: "Created note",
      list: "Notes",
      update: "Updated note",
      delete: "Deleted note",
    };
    return completedActionMap[content.action];
  }

  if (isSidebarSharedFiles(content)) {
    if (content.isExecuting) {
      const ready = content.files.length;
      const total = content.requestedPaths.length;
      return ready > 0
        ? `Sharing files (${ready}/${total})`
        : "Preparing files";
    }
    const count = content.files.length;
    return `Shared ${count} file${count !== 1 ? "s" : ""}`;
  }

  return "Unknown action";
}

const iconClass = "w-5 h-5 text-muted-foreground";

export function getSidebarIcon(content: SidebarContent): React.ReactNode {
  if (isSidebarFile(content)) {
    if (content.action === "searching") {
      return <FolderSearch className={iconClass} />;
    }
    return <Edit className={iconClass} />;
  }
  if (isSidebarProxy(content)) return <Radar className={iconClass} />;
  if (isSidebarTerminal(content)) return <Terminal className={iconClass} />;
  if (isSidebarWebSearch(content)) return <Search className={iconClass} />;
  if (isSidebarNotes(content)) return <StickyNote className={iconClass} />;
  if (isSidebarSharedFiles(content)) return <FileDown className={iconClass} />;
  return <Edit className={iconClass} />;
}

export function getToolName(content: SidebarContent): string {
  if (isSidebarFile(content)) {
    return content.action === "searching" ? "File Search" : "Editor";
  }
  if (isSidebarProxy(content)) return "Proxy";
  if (isSidebarTerminal(content)) {
    const interactive =
      content.session || isInteractiveShellAction(content.shellAction);
    return interactive ? "Interactive Terminal" : "Terminal";
  }
  if (isSidebarWebSearch(content)) return "Search";
  if (isSidebarNotes(content)) return "Notes";
  if (isSidebarSharedFiles(content)) return "Downloads";
  return "Tool";
}

export function getDisplayTarget(content: SidebarContent): string {
  if (isSidebarFile(content)) {
    return content.path.split("/").pop() || content.path;
  }
  if (isSidebarProxy(content)) {
    // Strip the tool name prefix (e.g. "send_request POST https://...") to avoid repeating the action
    const spaceIndex = content.command.indexOf(" ");
    return spaceIndex !== -1 ? content.command.slice(spaceIndex + 1) : "";
  }
  if (isSidebarTerminal(content)) {
    if (content.shellAction === "send" && content.input) {
      if (Array.isArray(content.input)) {
        return content.input.map((t) => formatSendInput(t)).join(" ");
      }
      return formatSendInput(content.input);
    }
    return content.command;
  }
  if (isSidebarWebSearch(content)) return content.query;
  if (isSidebarNotes(content)) {
    if (content.action === "list") {
      return `${content.totalCount} note${content.totalCount !== 1 ? "s" : ""}`;
    }
    return content.affectedTitle || "";
  }
  if (isSidebarSharedFiles(content)) {
    const names = content.files.length
      ? content.files.map((f) => f.name)
      : content.requestedPaths.map((p) => p.split("/").pop() || p);
    return names.join(", ");
  }
  return "";
}
