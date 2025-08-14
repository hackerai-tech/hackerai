import { ChevronDown } from "lucide-react";

interface ScrollToBottomButtonProps {
  isVisible: boolean;
  onClick: () => void;
}

export const ScrollToBottomButton = ({
  isVisible,
  onClick,
}: ScrollToBottomButtonProps) => {
  if (!isVisible) return null;

  return (
    <button
      onClick={onClick}
      className="bg-background border border-border rounded-full p-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 flex items-center justify-center"
      aria-label="Scroll to bottom"
      tabIndex={0}
    >
      <ChevronDown className="w-4 h-4 text-muted-foreground" />
    </button>
  );
};
