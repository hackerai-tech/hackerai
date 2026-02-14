import { memo, useMemo, useCallback, Fragment } from "react";
import { MessageActions } from "./MessageActions";
import { MessagePartHandler } from "./MessagePartHandler";
import { FilePartRenderer } from "./FilePartRenderer";
import { MessageEditor, EditableFile } from "./MessageEditor";
import { FeedbackInput } from "./FeedbackInput";
import { BranchIndicator } from "./BranchIndicator";
import { FinishReasonNotice } from "./FinishReasonNotice";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { FileSearch, WandSparkles } from "lucide-react";
import {
  extractMessageText,
  hasTextContent,
  extractWebSourcesFromMessage,
} from "@/lib/utils/message-utils";
import type { ChatStatus, ChatMessage, ChatMode } from "@/types";
import type { FileDetails } from "@/types/file";

interface MessageItemProps {
  message: ChatMessage;
  index: number;
  messagesLength: number;
  lastAssistantMessageIndex: number | undefined;
  status: ChatStatus;
  isHovered: boolean;
  isEditing: boolean;
  feedbackInputMessageId: string | null;
  tempChatFileDetails?: Map<string, FileDetails[]>;
  finishReason?: string;
  mode?: ChatMode;
  isTemporaryChat?: boolean;
  branchedFromChatId?: string;
  branchedFromChatTitle?: string;
  branchBoundaryIndex: number | undefined;
  showingLoadingIndicator?: boolean;
  // Inline status for mid-conversation summarization (when message already has content)
  summarizationStatus?: {
    status: "started" | "completed";
    message: string;
  } | null;
  // Callbacks
  onMouseEnter: (messageId: string) => void;
  onMouseLeave: () => void;
  onStartEdit: (messageId: string) => void;
  onSaveEdit: (newContent: string, remainingFileIds: string[]) => Promise<void>;
  onCancelEdit: () => void;
  onRegenerate: () => void;
  onBranchMessage?: (messageId: string) => void;
  onFeedback: (messageId: string, type: "positive" | "negative") => void;
  onFeedbackSubmit: (details: string) => Promise<void>;
  onFeedbackCancel: () => void;
  onShowAllFiles: (message: ChatMessage, fileDetails: FileDetails[]) => void;
  getCachedUrl: (fileId: string) => string | null | undefined;
}

// Custom comparison to minimize re-renders
function areMessageItemPropsEqual(
  prev: MessageItemProps,
  next: MessageItemProps,
): boolean {
  // Always re-render if these change
  if (prev.status !== next.status) return false;
  if (prev.isHovered !== next.isHovered) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.feedbackInputMessageId !== next.feedbackInputMessageId) return false;
  if (prev.index !== next.index) return false;
  if (prev.messagesLength !== next.messagesLength) return false;
  if (prev.lastAssistantMessageIndex !== next.lastAssistantMessageIndex)
    return false;
  if (prev.finishReason !== next.finishReason) return false;
  if (prev.showingLoadingIndicator !== next.showingLoadingIndicator)
    return false;
  if (prev.summarizationStatus?.status !== next.summarizationStatus?.status)
    return false;

  // Compare message by reference first, then by parts length for streaming
  if (prev.message !== next.message) {
    // During streaming, parts array changes
    if (prev.message.id !== next.message.id) return false;
    if (prev.message.parts.length !== next.message.parts.length) return false;
    // Check if last part changed (most likely during streaming)
    const prevLastPart = prev.message.parts[prev.message.parts.length - 1];
    const nextLastPart = next.message.parts[next.message.parts.length - 1];
    if (prevLastPart !== nextLastPart) return false;
  }

  return true;
}

export const MessageItem = memo(function MessageItem({
  message,
  index,
  messagesLength,
  lastAssistantMessageIndex,
  status,
  isHovered,
  isEditing,
  feedbackInputMessageId,
  tempChatFileDetails,
  finishReason,
  mode,
  isTemporaryChat,
  branchedFromChatId,
  branchedFromChatTitle,
  branchBoundaryIndex,
  onMouseEnter,
  onMouseLeave,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onRegenerate,
  onBranchMessage,
  onFeedback,
  onFeedbackSubmit,
  onFeedbackCancel,
  onShowAllFiles,
  getCachedUrl,
  showingLoadingIndicator,
  summarizationStatus,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const isLastAssistantMessage =
    message.role === "assistant" &&
    lastAssistantMessageIndex !== undefined &&
    index === lastAssistantMessageIndex;
  const canRegenerate = status === "ready" || status === "error";
  const isLastMessage = index === messagesLength - 1;

  // Memoize expensive computations
  const messageText = useMemo(
    () => extractMessageText(message.parts),
    [message.parts],
  );

  const messageHasTextContent = useMemo(
    () => hasTextContent(message.parts),
    [message.parts],
  );

  // Memoize part filtering - only recompute when parts change
  const { fileParts, nonFileParts } = useMemo(() => {
    const files = message.parts.filter((part) => part.type === "file");
    const nonFiles = message.parts.filter((part) => part.type !== "file");
    return { fileParts: files, nonFileParts: nonFiles };
  }, [message.parts]);

  // Pre-compute terminal output by toolCallId so TerminalToolHandler doesn't filter all parts per instance
  const terminalOutputByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    message.parts.forEach((p) => {
      if (p.type === "data-terminal" && (p as any).data?.toolCallId) {
        const id = (p as any).data.toolCallId;
        const terminal = (p as any).data?.terminal || "";
        map.set(id, (map.get(id) || "") + terminal);
      }
    });
    return map;
  }, [message.parts]);

  const hasFileContent = fileParts.length > 0;
  const hasAnyContent = messageHasTextContent || hasFileContent;

  // Memoize file details
  const effectiveFileDetails = useMemo(() => {
    if (isUser) return undefined;
    return (
      message.fileDetails || tempChatFileDetails?.get(message.id) || undefined
    );
  }, [isUser, message.fileDetails, message.id, tempChatFileDetails]);

  const savedFiles = useMemo(() => {
    if (isUser || !effectiveFileDetails) return [];
    return effectiveFileDetails.filter((f) => f.url || f.storageId || f.s3Key);
  }, [isUser, effectiveFileDetails]);

  const shouldShowBranchIndicator = Boolean(
    branchedFromChatId &&
    branchedFromChatTitle &&
    branchBoundaryIndex !== undefined &&
    branchBoundaryIndex >= 0 &&
    index === branchBoundaryIndex,
  );

  // Memoize web sources extraction
  const webSources = useMemo(() => {
    if (isUser) return [];
    if (isLastAssistantMessage && status === "streaming") return [];
    return extractWebSourcesFromMessage(message as any);
  }, [isUser, isLastAssistantMessage, status, message]);

  // Stable event handlers
  const handleMouseEnter = useCallback(() => {
    onMouseEnter(message.id);
  }, [onMouseEnter, message.id]);

  const handleEdit = useCallback(() => {
    onStartEdit(message.id);
  }, [onStartEdit, message.id]);

  const handleBranch = useCallback(() => {
    onBranchMessage?.(message.id);
  }, [onBranchMessage, message.id]);

  const handleFeedbackClick = useCallback(
    (type: "positive" | "negative") => {
      onFeedback(message.id, type);
    },
    [onFeedback, message.id],
  );

  // Memoize editable files for MessageEditor
  const editableFiles = useMemo(() => {
    return fileParts
      .filter((part) => part.type === "file" && (part as any).fileId)
      .map((part) => {
        const filePart = part as any;
        return {
          fileId: filePart.fileId as string,
          name: filePart.name || filePart.filename || "File",
          mediaType: filePart.mediaType,
          url: filePart.url || getCachedUrl(filePart.fileId as string),
        } as EditableFile;
      });
  }, [fileParts, getCachedUrl]);

  // Skip rendering empty assistant message when loading indicator is shown
  // (the loading indicator is shown separately in Messages.tsx)
  if (isLastAssistantMessage && !hasAnyContent && showingLoadingIndicator) {
    return null;
  }

  return (
    <Fragment>
      <div
        data-testid={isUser ? "user-message" : "assistant-message"}
        className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onMouseLeave}
        style={{
          // CSS content-visibility for off-screen performance
          contentVisibility: isLastMessage ? "visible" : "auto",
          containIntrinsicSize: isLastMessage ? undefined : "auto 100px",
        }}
      >
        {isEditing && isUser ? (
          <div className="w-full">
            <MessageEditor
              initialContent={messageText}
              initialFiles={editableFiles}
              onSave={onSaveEdit}
              onCancel={onCancelEdit}
            />
          </div>
        ) : (
          <div
            className={`${
              isUser
                ? "w-full flex flex-col gap-1 items-end"
                : "w-full text-foreground"
            } overflow-hidden`}
          >
            {/* Render file parts first for user messages */}
            {isUser && fileParts.length > 0 && (
              <div className="flex flex-wrap items-center justify-end gap-2 w-full">
                {fileParts.map((part, partIndex) => (
                  <FilePartRenderer
                    key={`${message.id}-file-${partIndex}`}
                    part={part}
                    partIndex={partIndex}
                    messageId={message.id}
                    totalFileParts={fileParts.length}
                  />
                ))}
              </div>
            )}

            {/* Render text and other parts */}
            {nonFileParts.length > 0 && (
              <div
                data-testid="message-content"
                className={`${
                  isUser
                    ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                    : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                } overflow-hidden`}
              >
                {isUser ? (
                  <div className="whitespace-pre-wrap">
                    {nonFileParts.map((part, partIndex) => (
                      <MessagePartHandler
                        key={`${message.id}-${partIndex}`}
                        message={message}
                        part={part}
                        partIndex={partIndex}
                        status={status}
                        terminalOutputByToolCallId={terminalOutputByToolCallId}
                      />
                    ))}
                  </div>
                ) : (
                  // For assistant messages, render all parts in original order
                  message.parts.map((part, partIndex) => (
                    <MessagePartHandler
                      key={`${message.id}-${partIndex}`}
                      message={message}
                      part={part}
                      partIndex={partIndex}
                      status={status}
                      isLastMessage={isLastMessage}
                      terminalOutputByToolCallId={terminalOutputByToolCallId}
                    />
                  ))
                )}
              </div>
            )}

            {/* For assistant messages without the user-specific styling, render files mixed with content */}
            {!isUser && fileParts.length > 0 && nonFileParts.length === 0 && (
              <div className="prose space-y-3 max-w-none dark:prose-invert min-w-0 overflow-hidden">
                {message.parts.map((part, partIndex) => (
                  <MessagePartHandler
                    key={`${message.id}-${partIndex}`}
                    message={message}
                    part={part}
                    partIndex={partIndex}
                    status={status}
                    terminalOutputByToolCallId={terminalOutputByToolCallId}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Saved files from tools (shown after message content for assistant) */}
        {!isUser && savedFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 w-full animate-in fade-in-0 duration-200">
            {savedFiles.length > 2 ? (
              <>
                {/* Show only last file when more than 2 */}
                <FilePartRenderer
                  key={`${message.id}-saved-file-${savedFiles.length - 1}`}
                  part={{
                    url: savedFiles[savedFiles.length - 1].url ?? undefined,
                    storageId: savedFiles[savedFiles.length - 1].storageId,
                    fileId: savedFiles[savedFiles.length - 1].fileId,
                    s3Key: savedFiles[savedFiles.length - 1].s3Key,
                    name: savedFiles[savedFiles.length - 1].name,
                    filename: savedFiles[savedFiles.length - 1].name,
                    mediaType: savedFiles[savedFiles.length - 1].mediaType,
                  }}
                  partIndex={savedFiles.length - 1}
                  messageId={message.id}
                  totalFileParts={savedFiles.length}
                />
                {/* View all files button */}
                <button
                  onClick={() =>
                    onShowAllFiles(message, effectiveFileDetails || [])
                  }
                  className="h-[55px] ps-4 pe-1.5 w-full max-w-80 min-w-64 flex items-center gap-1.5 rounded-[12px] border-[0.5px] border-border bg-background hover:bg-secondary transition-colors"
                  type="button"
                  aria-label="View all files"
                >
                  <FileSearch
                    className="w-4 h-4 text-muted-foreground"
                    strokeWidth={2}
                  />
                  <span className="text-sm text-muted-foreground">
                    View all files in this task
                  </span>
                </button>
              </>
            ) : (
              /* Show all files when 2 or less */
              savedFiles.map((file, fileIndex) => (
                <FilePartRenderer
                  key={`${message.id}-saved-file-${fileIndex}`}
                  part={{
                    url: file.url ?? undefined,
                    storageId: file.storageId,
                    fileId: file.fileId,
                    s3Key: file.s3Key,
                    name: file.name,
                    filename: file.name,
                    mediaType: file.mediaType,
                  }}
                  partIndex={fileIndex}
                  messageId={message.id}
                  totalFileParts={savedFiles.length}
                />
              ))
            )}
          </div>
        )}

        {/* Inline summarization status - only shown when last assistant message has content */}
        {isLastAssistantMessage &&
          hasAnyContent &&
          summarizationStatus?.status === "started" && (
            <div className="flex items-center gap-2 mt-2">
              <WandSparkles className="w-4 h-4 text-muted-foreground" />
              <Shimmer className="text-sm">
                {`${summarizationStatus.message}...`}
              </Shimmer>
            </div>
          )}

        {/* Finish reason notice under last assistant message */}
        {isLastAssistantMessage && status !== "streaming" && (
          <FinishReasonNotice finishReason={finishReason} mode={mode} />
        )}

        <MessageActions
          messageText={messageText}
          isUser={isUser}
          isLastAssistantMessage={isLastAssistantMessage}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
          onEdit={handleEdit}
          onBranch={!isUser && onBranchMessage ? handleBranch : undefined}
          isHovered={isHovered}
          isEditing={isEditing}
          status={status}
          onFeedback={handleFeedbackClick}
          existingFeedback={message.metadata?.feedbackType || null}
          isAwaitingFeedbackDetails={feedbackInputMessageId === message.id}
          hasFileContent={hasFileContent}
          isTemporaryChat={Boolean(isTemporaryChat)}
          sources={webSources}
        />

        {/* Show feedback input for negative feedback */}
        {feedbackInputMessageId === message.id && (
          <div className="w-full">
            <FeedbackInput
              onSend={onFeedbackSubmit}
              onCancel={onFeedbackCancel}
            />
          </div>
        )}
      </div>

      {/* Branch indicator - show after the branched message */}
      {shouldShowBranchIndicator && (
        <BranchIndicator
          branchedFromChatId={branchedFromChatId!}
          branchedFromChatTitle={branchedFromChatTitle!}
        />
      )}
    </Fragment>
  );
}, areMessageItemPropsEqual);
