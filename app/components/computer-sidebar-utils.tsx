import React from "react";
import {
  Edit,
  Terminal,
  Code2,
  Search,
  FolderSearch,
  StickyNote,
} from "lucide-react";
import {
  isSidebarFile,
  isSidebarTerminal,
  isSidebarPython,
  isSidebarWebSearch,
  isSidebarNotes,
  type SidebarContent,
  type NoteCategory,
} from "@/types/chat";
import { getShellActionLabel, formatSendInput } from "./tools/shell-tool-utils";

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

  if (isSidebarTerminal(content)) {
    return getShellActionLabel({
      isShellTool: !!content.shellAction,
      action: content.shellAction,
      pid: content.pid ?? undefined,
      session: content.session ?? undefined,
      isActive: content.isExecuting,
    });
  }

  if (isSidebarPython(content)) {
    return content.isExecuting ? "Executing Python" : "Python executed";
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
  if (isSidebarTerminal(content)) return <Terminal className={iconClass} />;
  if (isSidebarPython(content)) return <Code2 className={iconClass} />;
  if (isSidebarWebSearch(content)) return <Search className={iconClass} />;
  if (isSidebarNotes(content)) return <StickyNote className={iconClass} />;
  return <Edit className={iconClass} />;
}

export function getToolName(content: SidebarContent): string {
  if (isSidebarFile(content)) {
    return content.action === "searching" ? "File Search" : "Editor";
  }
  if (isSidebarTerminal(content)) return "Terminal";
  if (isSidebarPython(content)) return "Python";
  if (isSidebarWebSearch(content)) return "Search";
  if (isSidebarNotes(content)) return "Notes";
  return "Tool";
}

export function getDisplayTarget(content: SidebarContent): string {
  if (isSidebarFile(content)) {
    return content.path.split("/").pop() || content.path;
  }
  if (isSidebarTerminal(content)) {
    if (content.shellAction === "send" && content.input) {
      return formatSendInput(content.input);
    }
    return content.command;
  }
  if (isSidebarPython(content)) return content.code.replace(/\n/g, " ");
  if (isSidebarWebSearch(content)) return content.query;
  if (isSidebarNotes(content)) {
    if (content.action === "list") {
      return `${content.totalCount} note${content.totalCount !== 1 ? "s" : ""}`;
    }
    return content.affectedTitle || "";
  }
  return "";
}
