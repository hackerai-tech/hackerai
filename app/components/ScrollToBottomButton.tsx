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
      className="fixed bottom-34 left-1/2 transform -translate-x-1/2 bg-background border border-border rounded-full p-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 z-50 flex items-center justify-center"
      aria-label="Scroll to bottom"
      tabIndex={0}
    >
      <ChevronDown className="w-4 h-4 text-muted-foreground" />
    </button>
  );
};
