import { Button } from "@/components/ui/button";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import TextareaAutosize from "react-textarea-autosize";

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const ChatInput = ({
  input,
  setInput,
  onSubmit,
  onStop,
  status,
}: ChatInputProps) => {
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
    <div className="pb-3 relative px-4 mb-4">
      <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        <div className="flex flex-col gap-3 rounded-[22px] transition-all relative bg-input-chat py-3 max-h-[300px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border">
          <div className="overflow-y-auto pl-4 pr-2">
            <TextareaAutosize
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Hack, test, secure anything..."
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
