import { memo, useCallback, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FolderSearch } from "lucide-react";
import type { ChatStatus } from "@/types";
import { useGlobalState } from "../../contexts/GlobalState";

interface MatchToolHandlerProps {
  part: any;
  status: ChatStatus;
}

// Custom comparison for match handler
function areMatchPropsEqual(
  prev: MatchToolHandlerProps,
  next: MatchToolHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  if (prev.part.input !== next.part.input) return false;
  return true;
}

// Hoist result label parser outside component to avoid recreation
function getResultLabel(outputText: string, isGlob: boolean): string {
  if (outputText.startsWith("Found ")) {
    // Extract "Found X file(s)" or "Found X match(es)"
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
  if (outputText.startsWith("No files found")) {
    return "No files found";
  }
  if (outputText.startsWith("No matches found")) {
    return "No matches found";
  }
  if (outputText.startsWith("Search timed out")) {
    return "Search timed out";
  }
  if (
    outputText.startsWith("Error:") ||
    outputText.startsWith("Search failed")
  ) {
    return "Search failed";
  }
  return isGlob ? "Search complete" : "Search complete";
}

export const MatchToolHandler = memo(function MatchToolHandler({
  part,
  status,
}: MatchToolHandlerProps) {
  const { openSidebar } = useGlobalState();
  const { toolCallId, state, input, output } = part;
  const matchInput = input as
    | {
        action: "glob" | "grep";
        brief: string;
        scope: string;
        regex?: string;
        leading?: number;
        trailing?: number;
      }
    | undefined;

  const isGlob = matchInput?.action === "glob";

  const streamingLabel = useMemo(() => {
    if (!matchInput?.action) return "Searching";
    return isGlob ? "Finding files" : "Searching";
  }, [matchInput?.action, isGlob]);

  const target = useMemo(() => {
    if (!matchInput?.scope) return undefined;
    if (!isGlob && matchInput.regex) {
      return `"${matchInput.regex}" in ${matchInput.scope}`;
    }
    return matchInput.scope;
  }, [matchInput, isGlob]);

  // Memoize output parsing
  const outputText = useMemo(() => {
    if (state !== "output-available") return "";
    const matchOutput = output as { output: string };
    return matchOutput?.output || "";
  }, [state, output]);

  const resultLabel = useMemo(() => {
    return getResultLabel(outputText, isGlob);
  }, [outputText, isGlob]);

  const handleOpenInSidebar = useCallback(() => {
    if (!matchInput) return;
    openSidebar({
      path: matchInput.scope,
      content: outputText || "No results",
      action: "searching",
      toolCallId,
    });
  }, [matchInput, outputText, toolCallId, openSidebar]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenInSidebar();
      }
    },
    [handleOpenInSidebar],
  );

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<FolderSearch />}
          action={streamingLabel}
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<FolderSearch />}
          action={streamingLabel}
          target={target}
          isShimmer={true}
        />
      ) : null;
    case "output-available": {
      if (!matchInput) return null;

      return (
        <ToolBlock
          key={toolCallId}
          icon={<FolderSearch />}
          action={resultLabel}
          target={target}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    }
    default:
      return null;
  }
}, areMatchPropsEqual);
