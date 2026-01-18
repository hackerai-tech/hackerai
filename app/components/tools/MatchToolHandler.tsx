import ToolBlock from "@/components/ui/tool-block";
import { FolderSearch } from "lucide-react";
import type { ChatStatus } from "@/types";
import { useGlobalState } from "../../contexts/GlobalState";

interface MatchToolHandlerProps {
  part: any;
  status: ChatStatus;
}

export const MatchToolHandler = ({ part, status }: MatchToolHandlerProps) => {
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

  const getResultLabel = () => {
    return isGlob ? "Finding files" : "Searching";
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
          action={getResultLabel()}
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
