import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  ArrowUp,
  Square,
  MessageSquare,
  Infinity,
  ChevronDown,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import TextareaAutosize from "react-textarea-autosize";
import { useGlobalState } from "../contexts/GlobalState";

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
  isCentered?: boolean;
}

export const ChatInput = ({
  onSubmit,
  onStop,
  status,
  isCentered = false,
}: ChatInputProps) => {
  const { input, setInput, mode, setMode } = useGlobalState();
  const isGenerating = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "ready" && input.trim()) {
      onSubmit(e);
    }
  };

  // Handle keyboard shortcuts for stopping generation
  useHotkeys(
    "ctrl+c, meta+c",
    (e) => {
      e.preventDefault();
      onStop();
    },
    {
      enabled: isGenerating,
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
      description: "Stop AI generation",
    },
    [isGenerating, onStop],
  );

  return (
    <div className={`relative px-4 ${isCentered ? "" : "pb-3 mb-4"}`}>
      <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        <div className="flex flex-col gap-3 rounded-[22px] transition-all relative bg-input-chat py-3 max-h-[300px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border">
          <div className="overflow-y-auto pl-4 pr-2">
            <TextareaAutosize
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === "agent"
                  ? "Hack, test, secure anything"
                  : "Ask, learn, brainstorm"
              }
              className="flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-0 pt-[1px] border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-[15px] shadow-none resize-none min-h-[28px]"
              rows={1}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
          </div>
          <div className="px-3 flex gap-2 items-center">
            {/* Mode selector */}
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="bg-muted h-7 px-2 text-xs font-medium rounded-md hover:bg-muted/50 focus-visible:ring-1"
                  >
                    {mode === "agent" ? (
                      <>
                        <Infinity className="w-3 h-3 mr-1" />
                        Agent
                      </>
                    ) : (
                      <>
                        <MessageSquare className="w-3 h-3 mr-1" />
                        Ask
                      </>
                    )}
                    <ChevronDown className="w-3 h-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-54">
                  <DropdownMenuItem
                    onClick={() => setMode("ask")}
                    className="cursor-pointer"
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    <div className="flex flex-col">
                      <span className="font-medium">Ask</span>
                      <span className="text-xs text-muted-foreground">
                        Ask your hacking questions
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setMode("agent")}
                    className="cursor-pointer"
                  >
                    <Infinity className="w-4 h-4 mr-2" />
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Agent</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Hack, test, secure anything
                      </span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="min-w-0 flex gap-2 ml-auto flex-shrink items-center">
              {isGenerating ? (
                <TooltipPrimitive.Root>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={onStop}
                      variant="destructive"
                      className="rounded-full p-0 w-8 h-8 min-w-0"
                      aria-label="Stop generation"
                    >
                      <Square className="w-[15px] h-[15px]" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Stop (⌃C)</p>
                  </TooltipContent>
                </TooltipPrimitive.Root>
              ) : (
                <form onSubmit={handleSubmit}>
                  <TooltipPrimitive.Root>
                    <TooltipTrigger asChild>
                      <Button
                        type="submit"
                        disabled={status !== "ready" || !input.trim()}
                        variant="default"
                        className="rounded-full p-0 w-8 h-8 min-w-0"
                        aria-label="Send message"
                      >
                        <ArrowUp className="w-[15px] h-[15px]" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Send (⏎)</p>
                    </TooltipContent>
                  </TooltipPrimitive.Root>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
