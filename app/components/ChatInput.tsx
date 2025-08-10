import { Button } from "@/components/ui/button";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square } from "lucide-react";

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

  return (
    <div className="px-4 mb-4">
      <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        <div className="flex flex-col gap-3 rounded-[22px] transition-all relative bg-[var(--fill-input-chat)] py-3 max-h-[300px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask me anything..."
              className="w-full px-3 py-2 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
            <div className="flex justify-end pr-3">
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
                    <p>Stop</p>
                  </TooltipContent>
                </TooltipPrimitive.Root>
              ) : (
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
                    <p>Send</p>
                  </TooltipContent>
                </TooltipPrimitive.Root>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
