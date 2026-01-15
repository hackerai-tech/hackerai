import { useState } from "react";
import ToolBlock from "@/components/ui/tool-block";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { NotebookPen } from "lucide-react";
import type { ChatStatus } from "@/types";

interface MemoryToolHandlerProps {
  part: any;
  status: ChatStatus;
}

export const MemoryToolHandler = ({ part, status }: MemoryToolHandlerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const { toolCallId, state, input, output } = part;

  const memoryInput = (input || {}) as {
    action?: "create" | "update" | "delete";
    knowledge_to_store?: string;
    title?: string;
    existing_knowledge_id?: string;
  };

  const getActionText = (action?: string) => {
    switch (action) {
      case "create":
        return "Creating memory";
      case "update":
        return "Updating memory";
      case "delete":
        return "Deleting memory";
      default:
        return "Updating memory";
    }
  };

  const getMemoryContent = () => {
    // Try to get content from the output first (for completed tool executions)
    let content = "";
    const title = memoryInput.title;

    // Check if we have output data with memoryContent (tool execution completed)
    if (output && typeof output === "object" && output.memoryContent) {
      content = output.memoryContent;
    } else if (
      part.result &&
      typeof part.result === "object" &&
      part.result.memoryContent
    ) {
      // Fallback to result data
      content = part.result.memoryContent;
    } else {
      // Fallback to input content
      content = memoryInput.knowledge_to_store || "No content available";
    }

    return (
      <div className="space-y-2 max-h-40 overflow-y-auto">
        {title && (
          <div>
            <span className="font-semibold text-sm text-foreground">
              Title:
            </span>
            <div className="text-sm mt-1 max-h-12 overflow-y-auto">{title}</div>
          </div>
        )}
        <div className="text-sm whitespace-pre-wrap max-h-20 overflow-y-auto leading-relaxed">
          {content}
        </div>
      </div>
    );
  };

  const handleClick = () => {
    setIsOpen(!isOpen);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen(!isOpen);
    }
  };

  const handleMouseEnter = () => {
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    setIsOpen(false);
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<NotebookPen />}
          action={getActionText(memoryInput.action)}
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<NotebookPen />}
          action={getActionText(memoryInput.action)}
          target={memoryInput.title}
          isShimmer={true}
        />
      ) : null;

    case "output-available":
      return (
        <div className="block w-full my-2">
          <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto text-muted-foreground hover:text-foreground justify-start w-auto"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
              >
                <NotebookPen className="h-4 w-4" />
                {getActionText(memoryInput.action)}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-80 max-w-sm"
              align="start"
              sideOffset={8}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {getMemoryContent()}
            </PopoverContent>
          </Popover>
        </div>
      );

    default:
      return null;
  }
};
