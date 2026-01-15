import ToolBlock from "@/components/ui/tool-block";
import { Search, ExternalLink } from "lucide-react";
import type { ChatStatus } from "@/types";

interface WebSearchInput {
  queries?: string[];
}

interface OpenUrlInput {
  url?: string;
}

// Legacy web tool input (combined search + open_url)
interface LegacyWebInput {
  command?: "search" | "open_url";
  query?: string; // Legacy used single query string
  url?: string;
}

interface WebToolHandlerProps {
  part: {
    toolCallId: string;
    toolName?: string;
    type?: string;
    state: string;
    input?: WebSearchInput | OpenUrlInput | LegacyWebInput;
  };
  status: ChatStatus;
}

export const WebToolHandler = ({ part, status }: WebToolHandlerProps) => {
  const { toolCallId, toolName, type, state, input } = part;

  // Determine if this is an open_url action
  // Check toolName, part.type, or legacy command field
  const isOpenUrl =
    toolName === "open_url" ||
    type === "tool-open_url" ||
    (input as LegacyWebInput)?.command === "open_url";

  const getIcon = () => {
    return isOpenUrl ? <ExternalLink /> : <Search />;
  };

  const getAction = () => {
    return isOpenUrl ? "Opening URL" : "Searching web";
  };

  const getTarget = () => {
    if (!input) return undefined;

    // Handle open_url tool or legacy web tool with open_url command
    if (isOpenUrl) {
      return (input as OpenUrlInput | LegacyWebInput).url;
    }

    // Handle web_search tool (queries array)
    const searchInput = input as WebSearchInput;
    if (searchInput.queries && searchInput.queries.length > 0) {
      return searchInput.queries.join(", ");
    }

    // Handle legacy web tool (single query string)
    const legacyInput = input as LegacyWebInput;
    if (legacyInput.query) {
      return legacyInput.query;
    }

    return undefined;
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
          action={getAction()}
          target={getTarget()}
        />
      );

    default:
      return null;
  }
};
