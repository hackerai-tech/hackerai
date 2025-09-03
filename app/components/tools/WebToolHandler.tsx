import ToolBlock from "@/components/ui/tool-block";
import { Search, ExternalLink } from "lucide-react";
import type { ChatStatus } from "@/types";

interface WebToolHandlerProps {
  part: any;
  status: ChatStatus;
}

export const WebToolHandler = ({ part, status }: WebToolHandlerProps) => {
  const { toolCallId, state, input } = part;

  // Handle both new web tool format and legacy web_search format
  const webInput = input as
    | {
        command?: "search" | "open_url";
        query?: string;
        url?: string;
        explanation?: string;
      }
    | undefined;

  // Determine tool type - for backward compatibility: if no command, assume it's a search (legacy web_search)
  const isUrlCommand = webInput?.command === "open_url";

  const getIcon = () => {
    return isUrlCommand ? <ExternalLink /> : <Search />;
  };

  const getAction = (isCompleted = false) => {
    const action = isUrlCommand ? "Opening URL" : "Searching web";
    return isCompleted ? action.replace("ing", "ed") : action;
  };

  const getTarget = () => {
    if (!webInput) return undefined;
    return isUrlCommand ? webInput.url : webInput.query;
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getAction()}
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getAction()}
          target={getTarget()}
          isShimmer={true}
        />
      ) : null;

    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getAction(true)}
          target={getTarget()}
        />
      );

    default:
      return null;
  }
};

// Keep the old export for backward compatibility
export const WebSearchToolHandler = WebToolHandler;
