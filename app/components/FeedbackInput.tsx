import { useState } from "react";
import { Button } from "@/components/ui/button";
import TextareaAutosize from "react-textarea-autosize";

interface FeedbackInputProps {
  onSend: (details: string) => Promise<void>;
  onCancel: () => void;
}

export const FeedbackInput = ({ onSend, onCancel }: FeedbackInputProps) => {
  const [details, setDetails] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSend = async () => {
    if (!details.trim()) return;

    setIsSubmitting(true);
    try {
      await onSend(details.trim());
      setDetails("");
    } catch (error) {
      console.error("Failed to send feedback:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setDetails("");
    onCancel();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
    // Allow Shift+Enter for new lines
  };

  return (
    <div className="mt-2 p-3 bg-muted/50 rounded-lg border border-border animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
      <div className="flex flex-col space-y-3">
        <div className="flex-1">
          <TextareaAutosize
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={"What went wrong?"}
            className="flex rounded-md border-input focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden flex-1 bg-transparent p-2 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 w-full placeholder:text-muted-foreground text-[15px] shadow-none resize-none min-h-[36px]"
            rows={2}
            maxRows={6}
            autoFocus
            disabled={isSubmitting}
          />
        </div>
        <div className="flex justify-end space-x-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="shrink-0"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!details.trim() || isSubmitting}
            className="shrink-0"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
};
