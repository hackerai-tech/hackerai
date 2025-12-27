import React from "react";
import { UseChatHelpers } from "@ai-sdk/react";
import { Terminal, Copy, CornerDownLeft } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ToolBlock from "@/components/ui/tool-block";
import type { ChatMessage } from "@/types/chat";

interface TerminalCommandApprovalProps {
  state: "approval-requested" | "approval-responded" | "output-denied";
  terminalInput: {
    command: string;
    is_background: boolean;
  };
  approval?: {
    id: string;
    approved?: boolean;
  };
  autoRunMode: "ask-every-time" | "auto-run-sandbox" | "run-everything";
  setAutoRunMode: (
    mode: "ask-every-time" | "auto-run-sandbox" | "run-everything",
  ) => void;
  addToolApprovalResponse?: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  toolCallId: string;
  finalOutput: string;
  handleOpenInSidebar: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

export const TerminalCommandApproval: React.FC<
  TerminalCommandApprovalProps
> = ({
  state,
  terminalInput,
  approval,
  autoRunMode,
  setAutoRunMode,
  addToolApprovalResponse,
  toolCallId,
  finalOutput,
  handleOpenInSidebar,
  handleKeyDown,
}) => {
  const handleRun = () => {
    if (addToolApprovalResponse && approval?.id) {
      addToolApprovalResponse({
        id: approval.id,
        approved: true,
      });
    }
  };

  // Handle keyboard shortcut for the whole chat
  useHotkeys(
    "enter",
    (e) => {
      e.preventDefault();
      handleRun();
    },
    {
      enabled: state === "approval-requested",
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [handleRun, state],
  );

  switch (state) {
    case "approval-requested": {
      const commandName = terminalInput?.command?.split(" ")[0] || "command";

      return (
        <div className="rounded-2xl border border-border bg-card overflow-hidden w-full">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">
                Run command: {commandName}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  navigator.clipboard.writeText(terminalInput?.command || "");
                }}
                aria-label="Copy command"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Command Display */}
          <div className="px-4 py-3 bg-muted/20 font-mono text-sm">
            <span className="text-muted-foreground select-none">$ </span>
            <span className="text-foreground">
              {terminalInput?.command || ""}
            </span>
          </div>

          {/* Actions Footer */}
          <div className="px-4 py-3 flex items-center justify-between gap-3 bg-muted/30">
            <Select
              value={autoRunMode || "auto-run-sandbox"}
              onValueChange={(value) => {
                setAutoRunMode(
                  value as
                    | "ask-every-time"
                    | "auto-run-sandbox"
                    | "run-everything",
                );
              }}
            >
              <SelectTrigger className="w-fit border-none shadow-none focus:ring-0 bg-transparent h-auto p-0 hover:bg-transparent text-muted-foreground hover:text-foreground transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask-every-time">Ask Every Time</SelectItem>
                <SelectItem value="auto-run-sandbox">Run Everything</SelectItem>
                <SelectItem value="run-everything">
                  Run Everything (Unsandboxed)
                </SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (addToolApprovalResponse && approval?.id) {
                    addToolApprovalResponse({
                      id: approval.id,
                      approved: false,
                      reason: "User skipped command execution",
                    });
                  }
                }}
              >
                Skip
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" onClick={handleRun} className="gap-1.5">
                    Run
                    <CornerDownLeft className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  <div className="flex items-center gap-2 text-xs">
                    <span>Run this command</span>
                    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                      <span className="text-xs">↵</span> Enter
                    </kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      );
    }

    case "approval-responded": {
      const wasApproved = approval?.approved === true;
      const hasOutput = Boolean(finalOutput);
      const shouldBeClickable = wasApproved && hasOutput;

      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={
            wasApproved
              ? hasOutput
                ? "Executed"
                : "Command approved"
              : "Command denied"
          }
          target={terminalInput?.command || ""}
          isClickable={shouldBeClickable}
          onClick={shouldBeClickable ? handleOpenInSidebar : undefined}
          onKeyDown={shouldBeClickable ? handleKeyDown : undefined}
        />
      );
    }

    case "output-denied": {
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Command denied"
          target={terminalInput?.command || ""}
          isClickable={false}
        />
      );
    }

    default:
      return null;
  }
};
