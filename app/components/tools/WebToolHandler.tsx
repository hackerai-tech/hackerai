import ToolBlock from "@/components/ui/tool-block";
import { Search, ExternalLink } from "lucide-react";
import type { ChatStatus, SidebarWebSearch, WebSearchResult } from "@/types";
import { useGlobalState } from "../../contexts/GlobalState";

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
    output?: WebSearchResult[] | { result?: WebSearchResult[] };
  };
  status: ChatStatus;
}

export const WebToolHandler = ({ part, status }: WebToolHandlerProps) => {
  const { openSidebar } = useGlobalState();
  const { toolCallId, toolName, type, state, input, output } = part;

  // Determine if this is an open_url action
  // Check toolName, part.type, or legacy command field
  const isOpenUrl =
    toolName === "open_url" ||
    type === "tool-open_url" ||
    (input as LegacyWebInput)?.command === "open_url";

  const getIcon = () => {
    return isOpenUrl ? <ExternalLink /> : <Search />;
  };

  const getAction = (isCompleted = false) => {
    const action = isOpenUrl ? "Opening URL" : "Searching web";
    return isCompleted ? action.replace("ing", "ed") : action;
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

  const getQuery = (): string => {
    if (!input) return "";

    const searchInput = input as WebSearchInput;
    if (searchInput.queries && searchInput.queries.length > 0) {
      return searchInput.queries.join(", ");
    }

    const legacyInput = input as LegacyWebInput;
    if (legacyInput.query) {
      return legacyInput.query;
    }

    return "";
  };

  const handleOpenInSidebar = () => {
    if (isOpenUrl) return; // Don't open sidebar for URL opens

    const query = getQuery();
    if (!query) return;

    // Handle both formats: output as array directly, or output.result as array
    const rawResults = Array.isArray(output)
      ? output
      : (output as { result?: WebSearchResult[] })?.result;

    const results: WebSearchResult[] = Array.isArray(rawResults)
      ? rawResults.map((r: WebSearchResult) => ({
          title: r.title || "",
          url: r.url || "",
          content: r.content || "",
          date: r.date || null,
          lastUpdated: r.lastUpdated || null,
        }))
      : [];

    const sidebarWebSearch: SidebarWebSearch = {
      query,
      results,
      isSearching:
        state === "input-available" || state === "input-streaming",
      toolCallId,
    };

    openSidebar(sidebarWebSearch);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenInSidebar();
    }
  };

  const canOpenSidebar = !isOpenUrl;

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
          isClickable={canOpenSidebar}
          onClick={canOpenSidebar ? handleOpenInSidebar : undefined}
          onKeyDown={canOpenSidebar ? handleKeyDown : undefined}
        />
      ) : null;

    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getAction(true)}
          target={getTarget()}
          isClickable={canOpenSidebar}
          onClick={canOpenSidebar ? handleOpenInSidebar : undefined}
          onKeyDown={canOpenSidebar ? handleKeyDown : undefined}
        />
      );

    default:
      return null;
  }
};
