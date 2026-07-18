import { Button } from "@/components/ui/button";
import {
  Trash,
  CornerDownRight,
  MoreHorizontal,
  Pencil,
  ListX,
} from "lucide-react";
import type { QueuedMessage, QueueBehavior } from "@/types/chat";
import { useEffect, useState, type KeyboardEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import TextareaAutosize from "react-textarea-autosize";

interface QueuedMessagesPanelProps {
  messages: QueuedMessage[];
  onSendNow: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onEditingMessageChange: (messageId: string | null) => void;
  onDelete: (messageId: string) => void;
  isStreaming: boolean;
  queueBehavior?: QueueBehavior;
  onQueueBehaviorChange?: (behavior: QueueBehavior) => void;
}

interface QueuedMessageMenuProps {
  message: QueuedMessage;
  queueBehavior: QueueBehavior;
  onEdit: () => void;
  onQueueBehaviorChange?: (behavior: QueueBehavior) => void;
}

interface QueuedMessageRowProps {
  message: QueuedMessage;
  isEditing: boolean;
  isStreaming: boolean;
  queueBehavior: QueueBehavior;
  onSendNow: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onStartEditing: (messageId: string) => void;
  onFinishEditing: () => void;
  onDelete: (messageId: string) => void;
  onQueueBehaviorChange?: (behavior: QueueBehavior) => void;
}

const QueuedMessageMenu = ({
  message,
  queueBehavior,
  onEdit,
  onQueueBehaviorChange,
}: QueuedMessageMenuProps) => {
  const toggleQueueBehavior = () => {
    const nextBehavior = queueBehavior === "queue" ? "stop-and-send" : "queue";
    onQueueBehaviorChange?.(nextBehavior);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label={`More options for queued message: ${message.text}`}
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="cursor-pointer" onSelect={onEdit}>
          <Pencil />
          Edit message
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={toggleQueueBehavior}
        >
          <ListX />
          {queueBehavior === "queue" ? "Turn off queueing" : "Turn on queueing"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const QueuedMessageRow = ({
  message,
  isEditing,
  isStreaming,
  queueBehavior,
  onSendNow,
  onEdit,
  onStartEditing,
  onFinishEditing,
  onDelete,
  onQueueBehaviorChange,
}: QueuedMessageRowProps) => {
  const [editText, setEditText] = useState(message.text);

  const startEditing = () => {
    setEditText(message.text);
    onStartEditing(message.id);
  };

  const cancelEditing = () => {
    setEditText(message.text);
    onFinishEditing();
  };

  const saveEditing = () => {
    const trimmedText = editText.trim();
    if (!trimmedText && !message.files?.length) return;

    onEdit(message.id, trimmedText);
    onFinishEditing();
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      cancelEditing();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveEditing();
    }
  };

  const content = (
    <>
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <div className="space-y-2">
            <TextareaAutosize
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={handleEditKeyDown}
              minRows={1}
              maxRows={6}
              aria-label="Edit queued message"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={cancelEditing}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7"
                onClick={saveEditing}
                disabled={!editText.trim() && !message.files?.length}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-sm truncate text-foreground">
              {message.text}
            </div>
            {message.files && message.files.length > 0 && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {message.files.length} file
                {message.files.length > 1 ? "s" : ""}
              </div>
            )}
          </>
        )}
      </div>

      {!isEditing && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onSendNow(message.id)}
            className="h-7 px-2 text-xs"
            title={
              isStreaming
                ? "Stop the current response and steer with this message"
                : "Send this queued message now"
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
            aria-label={`Remove queued message: ${message.text}`}
            title="Remove from queue"
          >
            <Trash className="w-4 h-4" />
          </Button>
          <QueuedMessageMenu
            message={message}
            queueBehavior={queueBehavior}
            onEdit={startEditing}
            onQueueBehaviorChange={onQueueBehaviorChange}
          />
        </div>
      )}
    </>
  );

  const rowClassName = "flex items-start gap-2 py-0.5 min-w-0";

  return (
    <div className={rowClassName} data-testid={`queued-message-${message.id}`}>
      {content}
    </div>
  );
};

export const QueuedMessagesPanel = ({
  messages,
  onSendNow,
  onEdit,
  onEditingMessageChange,
  onDelete,
  isStreaming,
  queueBehavior = "queue",
  onQueueBehaviorChange,
}: QueuedMessagesPanelProps) => {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  useEffect(() => () => onEditingMessageChange(null), [onEditingMessageChange]);

  if (messages.length === 0) {
    return null;
  }

  const setEditingMessage = (messageId: string | null) => {
    setEditingMessageId(messageId);
    onEditingMessageChange(messageId);
  };

  const renderMessage = (message: QueuedMessage) => (
    <QueuedMessageRow
      key={message.id}
      message={message}
      isEditing={editingMessageId === message.id}
      isStreaming={isStreaming}
      queueBehavior={queueBehavior}
      onSendNow={onSendNow}
      onEdit={onEdit}
      onStartEditing={setEditingMessage}
      onFinishEditing={() => setEditingMessage(null)}
      onDelete={onDelete}
      onQueueBehaviorChange={onQueueBehaviorChange}
    />
  );

  return (
    <div className="mx-4 rounded-[22px_22px_0px_0px] border border-black/8 dark:border-border border-b-0 bg-input-chat">
      <div className="px-4 pt-3 pb-1 space-y-1 max-h-[240px] overflow-y-auto">
        {messages.map(renderMessage)}
      </div>
    </div>
  );
};
