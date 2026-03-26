import React, { memo, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { OpenAIIcon } from "../ModelSelector/icons";
import type {
  ChatStatus,
  SidebarContent,
  SidebarTerminal,
  SidebarFile,
  SidebarWebSearch,
  WebSearchResult,
} from "@/types/chat";
import {
  isSidebarTerminal,
  isSidebarFile,
  isSidebarWebSearch,
} from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface CodexToolHandlerProps {
  part: any;
  status: ChatStatus;
}

function arePropsEqual(
  prev: CodexToolHandlerProps,
  next: CodexToolHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  if (prev.part.input !== next.part.input) return false;
  if (prev.part.type !== next.part.type) return false;
  return true;
}

const codexIcon = <OpenAIIcon className="h-4 w-4" />;

/**
 * Parse a unified git diff into original and modified content.
 * Handles both full git diffs and compact patch hunks.
 */
function parseGitDiff(diff: string): {
  originalContent: string;
  modifiedContent: string;
} | null {
  if (!diff) return null;

  const lines = diff.split("\n");
  const original: string[] = [];
  const modified: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    // Skip diff headers
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("-")) {
      original.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modified.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      // Context line — appears in both
      original.push(line.slice(1));
      modified.push(line.slice(1));
    }
  }

  if (original.length === 0 && modified.length === 0) return null;

  return {
    originalContent: original.join("\n"),
    modifiedContent: modified.join("\n"),
  };
}

/** Map codex item types to action verbs and targets */
function getToolDisplay(itemType: string, input: any) {
  switch (itemType) {
    case "commandExecution":
      return {
        runningAction: "Running",
        doneAction: "Executed",
        target: input?.command || "command",
      };
    case "fileChange":
      return {
        runningAction: `${input?.action || "edit"}ing`,
        doneAction: `${input?.action || "edit"}ed`,
        target: input?.path || input?.file || "file",
      };
    case "webSearch":
      return {
        runningAction: "Searching",
        doneAction: "Searched",
        target: input?.toolLabel || input?.query || "web",
      };
    default:
      return {
        runningAction: "Running",
        doneAction: "Ran",
        target: input?.toolLabel || input?.command || itemType,
      };
  }
}

/**
 * Generic handler for ALL Codex tool calls (tool-codex_*).
 * Renders a ToolBlock and opens the correct sidebar view per tool type.
 */
export const CodexToolHandler = memo(function CodexToolHandler({
  part,
  status,
}: CodexToolHandlerProps) {
  const { state, input, output, toolCallId } = part;
  const isExecuting = state === "input-available" && status === "streaming";

  // Extract the codex item type (tool-codex_commandExecution → commandExecution)
  const itemType =
    input?.codexItemType || part.type?.replace("tool-codex_", "") || "unknown";

  const display = getToolDisplay(itemType, input);

  // Build the correct sidebar content type based on the Codex item type
  const sidebarContent = useMemo((): SidebarContent | null => {
    switch (itemType) {
      case "webSearch": {
        // Extract query from output (populated on item/completed) or input
        const query =
          output?.query || input?.toolLabel || input?.query || "web search";
        // Extract search results from output if available
        const action = output?.action;
        const queries: string[] = action?.queries || [];
        const results: WebSearchResult[] = queries.map((q: string) => ({
          title: q,
          url: "",
          content: "",
          date: null,
          lastUpdated: null,
        }));
        return {
          query,
          results,
          isSearching: isExecuting,
          toolCallId,
        } satisfies SidebarWebSearch;
      }

      case "fileChange": {
        const filePath = output?.path || input?.path || input?.file || "file";
        const changeAction = output?.action || input?.action || "edit";
        const actionMap: Record<string, SidebarFile["action"]> = {
          add: "writing",
          update: "editing",
          delete: "reading",
        };
        const rawDiff = output?.diff || input?.diff || "";
        const parsed = parseGitDiff(rawDiff);
        return {
          path: filePath,
          content: parsed?.modifiedContent || rawDiff || output?.output || "",
          action: actionMap[changeAction] || "editing",
          toolCallId,
          isExecuting,
          originalContent: parsed?.originalContent,
          modifiedContent: parsed?.modifiedContent,
        } satisfies SidebarFile;
      }

      case "commandExecution":
      default: {
        // Terminal-style sidebar for commands and unknown tool types
        const command =
          input?.command || input?.toolLabel || input?.path || display.target;
        if (!command) return null;
        return {
          command,
          output: output?.output || output?.diff || "",
          isExecuting,
          toolCallId,
        } satisfies SidebarTerminal;
      }
    }
  }, [itemType, input, output, isExecuting, toolCallId, display.target]);

  // Pick the correct type guard for the sidebar content type
  const typeGuard = useMemo(() => {
    switch (itemType) {
      case "webSearch":
        return isSidebarWebSearch;
      case "fileChange":
        return isSidebarFile;
      default:
        return isSidebarTerminal;
    }
  }, [itemType]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard,
  });

  return (
    <ToolBlock
      icon={codexIcon}
      action={isExecuting ? display.runningAction : display.doneAction}
      target={display.target}
      isShimmer={isExecuting}
      isClickable={true}
      onClick={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
    />
  );
}, arePropsEqual);
