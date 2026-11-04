import { ChevronDown } from "lucide-react";
import { useGlobalState } from "@/app/contexts/GlobalState";

interface ScrollToBottomButtonProps {
  onClick: () => void;
  hasMessages: boolean;
  isAtBottom: boolean;
  /** Inline sits beside the mobile goal pill; floating sits above the composer. */
  variant?: "floating" | "inline";
}

export const ScrollToBottomButton = ({
  onClick,
  hasMessages,
  isAtBottom,
  variant = "floating",
}: ScrollToBottomButtonProps) => {
  const { isTodoPanelExpanded } = useGlobalState();

  const shouldShowScrollButton =
    hasMessages && !isAtBottom && !isTodoPanelExpanded;

  if (!shouldShowScrollButton) return null;

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        className={
          variant === "inline"
            ? // Matches the goal pill; the pseudo-element extends the tap target
              // to 44x40 while staying inside the goal row.
              "relative flex size-9 items-center justify-center rounded-full border bg-background/95 shadow-sm backdrop-blur-md transition-colors before:absolute before:-inset-x-1 before:-inset-y-0.5 before:content-[''] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            : "bg-background border border-border rounded-full p-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 flex items-center justify-center"
        }
        aria-label="Scroll to bottom"
        tabIndex={0}
      >
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      </button>
    </div>
  );
};
