import { memo, useCallback, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { Search, ExternalLink } from "lucide-react";
import type { ChatStatus, SidebarWebSearch, WebSearchResult } from "@/types";
import { isSidebarWebSearch } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface WebSearchInput {
  queries?: string[];
  brief?: string;
}

interface OpenUrlInput {
  url?: string;
  brief?: string;
}

// Legacy web tool input (combined search + open_url)
interface LegacyWebInput {
  command?: "search" | "open_url";
  query?: string; // Legacy used single query string
  url?: string;
  brief?: string;
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

// Custom comparison for web tool handler
function areWebPropsEqual(
  prev: WebToolHandlerProps,
  next: WebToolHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  return true;
}

export const WebToolHandler = memo(function WebToolHandler({
  part,
  status,
}: WebToolHandlerProps) {
  const { toolCallId, toolName, type, state, input, output } = part;

  // Determine if this is an open_url action
  const isOpenUrl =
    toolName === "open_url" ||
    type === "tool-open_url" ||
    (input as LegacyWebInput)?.command === "open_url";

  const icon = useMemo(
    () => (isOpenUrl ? <ExternalLink /> : <Search />),
    [isOpenUrl],
  );

  const getAction = useCallback(
    (isCompleted = false) => {
      const action = isOpenUrl ? "Opening URL" : "Searching web";
      return isCompleted ? action.replace("ing", "ed") : action;
    },
    [isOpenUrl],
  );

  const target = useMemo(() => {
    if (!input) return undefined;

    if (isOpenUrl) {
      return (input as OpenUrlInput | LegacyWebInput).url;
    }

    const searchInput = input as WebSearchInput;
    if (searchInput.queries && searchInput.queries.length > 0) {
      return searchInput.queries.join(", ");
    }

    const legacyInput = input as LegacyWebInput;
    if (legacyInput.query) {
      return legacyInput.query;
    }

    return undefined;
  }, [input, isOpenUrl]);

  const query = useMemo((): string => {
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
  }, [input]);

  // Memoize parsed results for sidebar
  const parsedResults = useMemo((): WebSearchResult[] => {
    const rawResults = Array.isArray(output)
      ? output
      : (output as { result?: WebSearchResult[] })?.result;

    return Array.isArray(rawResults)
      ? rawResults.map((r: WebSearchResult) => ({
          title: r.title || "",
          url: r.url || "",
          content: r.content || "",
          date: r.date || null,
          lastUpdated: r.lastUpdated || null,
        }))
      : [];
  }, [output]);

  const sidebarContent = useMemo((): SidebarWebSearch | null => {
    if (isOpenUrl || !query) return null;
    return {
      query,
      results: parsedResults,
      isSearching: state === "input-available" || state === "input-streaming",
      toolCallId,
    };
  }, [isOpenUrl, query, parsedResults, state, toolCallId]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarWebSearch,
    disabled: isOpenUrl,
  });

  const canOpenSidebar = !isOpenUrl;

  // Mirror the shell/file pattern: when the model supplies a `brief`, it
  // stands alone as the block label (no target). Pre-input states without a
  // brief yet fall back to the existing verb + target.
  const briefText =
    (input as { brief?: string } | undefined)?.brief?.trim() || "";
  const useBriefOnly = !!briefText;
  const briefLabel = (fallback: string) =>
    useBriefOnly ? briefText : fallback;
  const briefTarget = (fallback: string | undefined) =>
    useBriefOnly ? undefined : fallback;

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={icon}
          action={briefLabel(getAction())}
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={icon}
          action={briefLabel(getAction())}
          target={briefTarget(target)}
          isShimmer={true}
        />
      ) : null;

    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={icon}
          action={briefLabel(getAction(true))}
          target={briefTarget(target)}
          isClickable={canOpenSidebar}
          onClick={canOpenSidebar ? handleOpenInSidebar : undefined}
          onKeyDown={canOpenSidebar ? handleKeyDown : undefined}
        />
      );

    default:
      return null;
  }
}, areWebPropsEqual);
