import ToolBlock from "@/components/ui/tool-block";
import { Search } from "lucide-react";

interface WebSearchToolHandlerProps {
  part: any;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const WebSearchToolHandler = ({
  part,
  status,
}: WebSearchToolHandlerProps) => {
  const { toolCallId, state, input } = part;
  const webInput = input as {
    query: string;
    explanation?: string;
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Search />}
          action="Searching web"
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Search />}
          action="Searching web"
          target={webInput.query}
          isShimmer={true}
        />
      ) : null;
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Search />}
          action="Searched web"
          target={webInput.query}
        />
      );
    default:
      return null;
  }
};


