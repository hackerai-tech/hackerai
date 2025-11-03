import { Button } from "@/components/ui/button";
import { X, Send } from "lucide-react";
import type { QueuedMessage } from "@/types/chat";

interface QueuedMessagesPanelProps {
  messages: QueuedMessage[];
  onSendNow: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  isStreaming: boolean;
}

export const QueuedMessagesPanel = ({
  messages,
  onSendNow,
  onDelete,
  isStreaming,
}: QueuedMessagesPanelProps) => {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 rounded-t-[22px] transition-all relative bg-input-chat py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border border-b-0">
      <div className="px-3 mb-1">
        <div className="text-xs text-muted-foreground font-medium">
          {messages.length} message{messages.length > 1 ? "s" : ""} queued
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className="flex items-start gap-2 p-2.5 rounded-lg border bg-secondary/50 dark:bg-secondary/30 hover:bg-secondary/70 dark:hover:bg-secondary/40 transition-colors"
          >
            {/* Message preview */}
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate text-foreground">
                {message.text}
              </div>
              {message.files && message.files.length > 0 && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {message.files.length} file
                  {message.files.length > 1 ? "s" : ""}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onSendNow(message.id)}
                disabled={!isStreaming}
                className="h-7 px-2 text-xs"
                title={
                  isStreaming
                    ? "Cancel current response and send this now"
                    : "Waiting for current response to complete"
                }
              >
                <Send className="w-3 h-3 mr-1" />
                Send Now
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onDelete(message.id)}
                className="h-7 w-7 p-0"
                title="Remove from queue"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
