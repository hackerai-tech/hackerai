import { ChevronDown } from "lucide-react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { getTodoStats } from "@/lib/utils/todo-utils";

interface ScrollToBottomButtonProps {
  onClick: () => void;
  hasMessages: boolean;
  isAtBottom: boolean;
}

export const ScrollToBottomButton = ({
  onClick,
  hasMessages,
  isAtBottom,
}: ScrollToBottomButtonProps) => {
  const { isTodoPanelExpanded, todos } = useGlobalState();

  const shouldShowScrollButton =
    hasMessages && !isAtBottom && !isTodoPanelExpanded;

  if (!shouldShowScrollButton) return null;

  // Check if there are any active todos to determine positioning (same logic as TodoPanel)
  const stats = getTodoStats(todos);
  const hasActiveTodos = stats.inProgress > 0 || stats.pending > 0;
  const bottomPosition = hasActiveTodos ? "bottom-42" : "bottom-34";

  return (
    <div
      className={`absolute ${bottomPosition} left-1/2 -translate-x-1/2 z-40 transition-all duration-300`}
    >
      <button
        onClick={onClick}
        className="bg-background border border-border rounded-full p-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 flex items-center justify-center"
        aria-label="Scroll to bottom"
        tabIndex={0}
      >
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      </button>
    </div>
  );
};
