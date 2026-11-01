import { ChevronDown } from "lucide-react";
import { useGlobalState } from "@/app/contexts/GlobalState";

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
  const { isTodoPanelExpanded } = useGlobalState();

  const shouldShowScrollButton =
    hasMessages && !isAtBottom && !isTodoPanelExpanded;

  if (!shouldShowScrollButton) return null;

  return (
    <div>
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
