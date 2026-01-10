import ToolBlock from "@/components/ui/tool-block";
import { FolderSearch } from "lucide-react";
import type { ChatStatus } from "@/types";
import { useGlobalState } from "../../contexts/GlobalState";

interface MatchToolHandlerProps {
  part: any;
  status: ChatStatus;
}

export const MatchToolHandler = ({
  part,
  status,
}: MatchToolHandlerProps) => {
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

  const getStreamingLabel = () => {
    if (!matchInput?.action) return "Searching";
    return isGlob ? "Finding files" : "Searching";
  };

  const getTarget = () => {
    if (!matchInput?.scope) return undefined;
    if (!isGlob && matchInput.regex) {
      return `"${matchInput.regex}" in ${matchInput.scope}`;
    }
    return matchInput.scope;
  };

  // Parse the output to get a summary label
  const getResultLabel = (outputText: string) => {
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
    if (outputText.startsWith("Error:") || outputText.startsWith("Search failed")) {
      return "Search failed";
    }
    return isGlob ? "Search complete" : "Search complete";
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<FolderSearch />}
          action={getStreamingLabel()}
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<FolderSearch />}
          action={getStreamingLabel()}
          target={getTarget()}
          isShimmer={true}
        />
      ) : null;
    case "output-available": {
      if (!matchInput) return null;
      const matchOutput = output as { output: string };
      const outputText = matchOutput?.output || "";

      const handleOpenInSidebar = () => {
        openSidebar({
          path: matchInput.scope,
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
          key={toolCallId}
          icon={<FolderSearch />}
          action={getResultLabel(outputText)}
          target={getTarget()}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    }
    default:
      return null;
  }
};
