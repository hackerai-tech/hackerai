import { Button } from "@/components/ui/button";
import {
  Trash,
  CornerDownRight,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Check,
} from "lucide-react";
import type { QueuedMessage, QueueBehavior } from "@/types/chat";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface QueuedMessagesPanelProps {
  messages: QueuedMessage[];
  onSendNow: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  isStreaming: boolean;
  queueBehavior?: QueueBehavior;
  onQueueBehaviorChange?: (behavior: QueueBehavior) => void;
}

const queueBehaviorOptions: Array<{
  value: QueueBehavior;
  label: string;
}> = [
  { value: "queue", label: "Queue after current message" },
  { value: "stop-and-send", label: "Stop & send right away" },
];

interface QueueSettingsMenuProps {
  queueBehavior: QueueBehavior;
  onQueueBehaviorChange?: (behavior: QueueBehavior) => void;
}

const QueueSettingsMenu = ({
  queueBehavior,
  onQueueBehaviorChange,
}: QueueSettingsMenuProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        aria-label="Queue settings"
      >
        <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
        When to send follow-ups
      </div>
      {queueBehaviorOptions.map((option) => (
        <DropdownMenuItem
          key={option.value}
          onClick={() => onQueueBehaviorChange?.(option.value)}
          className="flex items-center justify-between cursor-pointer"
        >
          <span>{option.label}</span>
          {queueBehavior === option.value && <Check className="w-4 h-4" />}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const QueuedMessagesPanel = ({
  messages,
  onSendNow,
  onDelete,
  isStreaming,
  queueBehavior = "queue",
  onQueueBehaviorChange,
}: QueuedMessagesPanelProps) => {
  const [isExpanded, setIsExpanded] = useState(true);

  if (messages.length === 0) {
    return null;
  }

  const isSingleMessage = messages.length === 1;

  const handleToggleExpand = () => {
    setIsExpanded((expanded) => !expanded);
  };

  const renderMessage = (message: QueuedMessage, showSettings = false) => (
    <div
      key={message.id}
      className="flex items-start gap-2 transition-colors min-w-0"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate text-foreground">{message.text}</div>
        {message.files && message.files.length > 0 && (
          <div className="text-xs text-muted-foreground mt-0.5">
            {message.files.length} file
            {message.files.length > 1 ? "s" : ""}
          </div>
        )}
      </div>

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
              ? "Stop the current response and steer with this message"
              : "Waiting for the current response to complete"
          }
        >
          <CornerDownRight className="w-3 h-3 mr-1" />
          Steer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onDelete(message.id)}
          className="h-7 w-7 p-0"
          aria-label="Remove queued message"
          title="Remove from queue"
        >
          <Trash className="w-4 h-4" />
        </Button>
        {showSettings && (
          <QueueSettingsMenu
            queueBehavior={queueBehavior}
            onQueueBehaviorChange={onQueueBehaviorChange}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-4 rounded-[22px_22px_0px_0px] shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border border-b-0 bg-input-chat">
      {isSingleMessage ? (
        <div className="px-4 py-3">{renderMessage(messages[0], true)}</div>
      ) : (
        <>
          <div className="flex items-center px-4 transition-all duration-300 py-2">
            <button
              type="button"
              onClick={handleToggleExpand}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer focus:outline-none rounded-md p-1 -m-1 flex-1"
              aria-label={
                isExpanded
                  ? "Collapse queued messages"
                  : "Expand queued messages"
              }
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              )}
              <h3 className="text-muted-foreground text-sm font-medium">
                {messages.length} Queued
              </h3>
            </button>

            <QueueSettingsMenu
              queueBehavior={queueBehavior}
              onQueueBehaviorChange={onQueueBehaviorChange}
            />
          </div>

          {isExpanded && (
            <div className="border-t border-border px-4 py-3 space-y-2 max-h-[200px] overflow-y-auto">
              {messages.map((message) => renderMessage(message))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
