"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { TodoPanel } from "../TodoPanel";
import type { ChatStatus } from "@/types";
import { FileUploadPreview } from "../FileUploadPreview";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import { ScrollToBottomButton } from "../ScrollToBottomButton";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import { readGeneratedTextAttachment } from "@/app/hooks/useTauri";
import {
  getDraftAttachmentsById,
  removeDraft,
  removeDraftAttachments,
  upsertDraftAttachments,
  type ConversationDraftAttachment,
} from "@/lib/utils/client-storage";
import {
  RateLimitWarning,
  type RateLimitWarningData,
} from "../RateLimitWarning";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { toast } from "sonner";
import { NULL_THREAD_DRAFT_ID } from "@/lib/utils/client-storage";
import { SandboxSelector } from "../SandboxSelector";
import { AgentPermissionSelector } from "../AgentPermissionSelector";
import { ChatInputTextarea } from "./ChatInputTextarea";
import { ChatInputToolbar } from "./ChatInputToolbar";
import { AgentApprovalPrompt } from "./AgentApprovalPrompt";
import type { UploadedFileState } from "@/types/file";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  type ActiveAgentToolApprovalRequest,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import { PASTED_TEXT_INLINE_RESTORE_MAX_CHARS } from "@/lib/utils/pasted-text-attachments";
import {
  reconnectOnlineStatus,
  useOnlineStatus,
} from "@/app/hooks/useOnlineStatus";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void | boolean | Promise<void | boolean>;
  onStop: () => void | boolean | Promise<void | boolean>;
  onReconnect?: () => void | Promise<void>;
  onSendNow: (messageId: string) => void;
  status: ChatStatus;
  isCentered?: boolean;
  hasMessages?: boolean;
  isAtBottom?: boolean;
  onScrollToBottom?: () => void;
  hideStop?: boolean;
  isNewChat?: boolean;
  clearDraftOnSubmit?: boolean;
  chatId?: string;
  rateLimitWarning?: RateLimitWarningData;
  onDismissRateLimitWarning?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  restoreDraftAttachments?: boolean;
  storedApprovalRequest?: ActiveAgentToolApprovalRequest | null;
  offlineProtection?: boolean;
  sendDisabledReason?: string;
  isResolvingInitialState?: boolean;
}

const ChatInputLoadingState = ({
  showAgentControls,
}: {
  showAgentControls: boolean;
}) => (
  <div
    aria-label="Loading task input"
    aria-live="polite"
    className="relative min-w-0 px-4 pb-3"
    data-testid="chat-input-loading-state"
    role="status"
  >
    <div className="mx-auto w-full min-w-0 max-w-full sm:min-w-[390px] sm:max-w-[768px]">
      <div
        className="chat-input-glass-surface relative z-10 flex h-[98px] flex-col justify-center gap-2 rounded-[22px] border border-black/8 px-4 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] dark:border-border"
        data-testid="chat-input-loading-surface"
      >
        <div className="h-3 w-32 animate-pulse rounded-full bg-muted-foreground/15 motion-reduce:animate-none" />
        <div className="h-3 w-20 animate-pulse rounded-full bg-muted-foreground/10 motion-reduce:animate-none" />
      </div>
      {showAgentControls ? (
        <div
          aria-hidden="true"
          className="chat-input-glass-context relative z-0 mx-6 -mt-2 h-10 rounded-b-[18px] border border-t-0 border-black/8 md:hidden dark:border-border/70"
          data-testid="chat-input-loading-controls"
        />
      ) : null}
    </div>
  </div>
);

const isBrowserFile = (file: UploadedFileState["file"]): file is File =>
  typeof globalThis.File !== "undefined" && file instanceof globalThis.File;

const draftAttachmentToUploadedFile = (
  attachment: ConversationDraftAttachment,
): UploadedFileState => {
  const isLocalDesktop = attachment.storage === "local-desktop";
  const generatedTextAttachmentId =
    attachment.generatedTextAttachmentId ||
    (!isLocalDesktop && attachment.kind === "pasted-text"
      ? attachment.fileId
      : undefined);
  const uploadedFile: UploadedFileState = {
    file: {
      name: attachment.name,
      type: attachment.mediaType,
      size: attachment.size,
      lastModified: attachment.timestamp,
    },
    uploading: false,
    uploaded: true,
    storage: isLocalDesktop ? "local-desktop" : "s3",
    tokens: attachment.tokens,
  };

  if (attachment.fileId) {
    uploadedFile.fileId = attachment.fileId;
  }

  if (
    attachment.kind === "pasted-text" ||
    attachment.generatedSource === "pasted-text"
  ) {
    uploadedFile.generatedSource = "pasted-text";
    uploadedFile.generatedTextAttachmentId = generatedTextAttachmentId;
    if (isLocalDesktop && generatedTextAttachmentId) {
      uploadedFile.localAttachmentId = generatedTextAttachmentId;
    }
  }

  return uploadedFile;
};

const uploadedFileToDraftAttachment = (
  uploadedFile: UploadedFileState,
): ConversationDraftAttachment | null => {
  const generatedTextAttachment = uploadedFile.generatedTextAttachment;
  const generatedTextAttachmentId =
    generatedTextAttachment?.id || uploadedFile.generatedTextAttachmentId;
  const isGeneratedPastedText =
    uploadedFile.generatedSource === "pasted-text" ||
    Boolean(generatedTextAttachmentId);
  const hasCommittedGeneratedTextFile =
    isGeneratedPastedText &&
    (uploadedFile.storage === "local-desktop"
      ? Boolean(generatedTextAttachmentId)
      : Boolean(uploadedFile.fileId));

  if (
    (!uploadedFile.uploaded || uploadedFile.uploading || uploadedFile.error) &&
    !hasCommittedGeneratedTextFile
  ) {
    return null;
  }

  if (uploadedFile.storage === "local-desktop") {
    if (!isGeneratedPastedText || !generatedTextAttachmentId) {
      return null;
    }

    return {
      kind: "pasted-text",
      storage: "local-desktop",
      name: uploadedFile.file.name,
      mediaType: uploadedFile.file.type || "text/plain",
      size: uploadedFile.file.size,
      tokens: uploadedFile.tokens,
      timestamp: uploadedFile.file.lastModified,
      generatedSource: "pasted-text",
      generatedTextAttachmentId,
    };
  }

  if (!uploadedFile.fileId) {
    return null;
  }

  return {
    kind: isGeneratedPastedText ? "pasted-text" : "file",
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    mediaType: uploadedFile.file.type || "application/octet-stream",
    size: uploadedFile.file.size,
    tokens: uploadedFile.tokens,
    timestamp: isBrowserFile(uploadedFile.file)
      ? Date.now()
      : uploadedFile.file.lastModified,
    ...(isGeneratedPastedText
      ? {
          generatedSource: "pasted-text" as const,
        }
      : {}),
    ...(generatedTextAttachmentId
      ? {
          generatedTextAttachmentId,
        }
      : {}),
  };
};

export const ChatInput = ({
  onSubmit,
  onStop,
  onReconnect,
  onSendNow,
  status,
  isCentered = false,
  hasMessages = false,
  isAtBottom = true,
  onScrollToBottom,
  hideStop = false,
  isNewChat = false,
  clearDraftOnSubmit = true,
  chatId,
  rateLimitWarning,
  onDismissRateLimitWarning,
  placeholder,
  autoFocus,
  restoreDraftAttachments = true,
  storedApprovalRequest,
  offlineProtection = true,
  sendDisabledReason,
  isResolvingInitialState = false,
}: ChatInputProps) => {
  const {
    chatMode,
    setChatMode,
    uploadedFiles,
    setUploadedFiles,
    isUploadingFiles,
    messageQueue,
    updateQueuedMessage,
    setEditingQueuedMessageId,
    removeQueuedMessage,
    queueBehavior,
    setQueueBehavior,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
    subscription,
    isCheckingProPlan,
    hasLocalSandbox,
    freeDesktopAgentOnlyActive,
    desktopBridgeStatus,
    defaultLocalSandboxPreference,
  } = useGlobalState();
  const input = useComposerInput();
  const { setInput } = useComposerActions();
  const isOnline = useOnlineStatus();
  const isOffline = offlineProtection && !isOnline;
  const {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleUpdateGeneratedTextFile,
    handleAttachClick,
  } = useFileUpload(chatMode);
  const { activeToolApprovalRequest } = useAgentApproval();

  const isGenerating = status === "submitted" || status === "streaming";
  const isAgent = isAgentMode(chatMode);
  const approvalRequest = useMemo(
    () =>
      activeToolApprovalRequest &&
      storedApprovalRequest &&
      activeToolApprovalRequest.approvalId ===
        storedApprovalRequest.approvalId &&
      activeToolApprovalRequest.toolCallId === storedApprovalRequest.toolCallId
        ? {
            ...storedApprovalRequest,
            ...activeToolApprovalRequest,
            ...(storedApprovalRequest.autoReview
              ? { autoReview: storedApprovalRequest.autoReview }
              : {}),
          }
        : (activeToolApprovalRequest ?? storedApprovalRequest),
    [activeToolApprovalRequest, storedApprovalRequest],
  );
  const [isStoppingAgent, setIsStoppingAgent] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const showAgentApprovalPrompt = !!approvalRequest && !isStoppingAgent;

  useEffect(() => {
    if (!isGenerating && !activeToolApprovalRequest && !storedApprovalRequest) {
      setIsStoppingAgent(false);
    }
  }, [activeToolApprovalRequest, isGenerating, storedApprovalRequest]);

  const handleAgentStop = async () => {
    setIsStoppingAgent(true);
    try {
      const stopped = await onStop();
      if (stopped === false) {
        setIsStoppingAgent(false);
      }
    } catch {
      setIsStoppingAgent(false);
    }
  };

  const draftId =
    isNewChat && !hasMessages ? "new" : chatId || NULL_THREAD_DRAFT_ID;
  const skipNextAttachmentPersistRef = useRef(false);
  const hasPersistedDraftAttachmentsRef = useRef(false);
  const uploadedFilesRef = useRef(uploadedFiles);
  const prevDraftIdRef = useRef(draftId);
  const draftTextFileIds = useMemo(
    () =>
      restoreDraftAttachments
        ? uploadedFiles.flatMap((uploadedFile) => {
            if (
              uploadedFile.uploaded &&
              !uploadedFile.uploading &&
              !uploadedFile.error &&
              uploadedFile.storage !== "local-desktop" &&
              uploadedFile.generatedSource === "pasted-text" &&
              !uploadedFile.generatedTextAttachment &&
              uploadedFile.fileId
            ) {
              return [uploadedFile.fileId as Id<"files">];
            }

            return [];
          })
        : [],
    [restoreDraftAttachments, uploadedFiles],
  );
  const draftTextFileContents = useQuery(
    api.fileStorage.getTextFileContentForCurrentUser,
    draftTextFileIds.length > 0 ? { fileIds: draftTextFileIds } : "skip",
  );
  const localDraftTextFiles = useMemo(
    () =>
      restoreDraftAttachments
        ? uploadedFiles.flatMap((uploadedFile, index) => {
            if (
              uploadedFile.uploaded &&
              !uploadedFile.uploading &&
              !uploadedFile.error &&
              uploadedFile.storage === "local-desktop" &&
              uploadedFile.generatedSource === "pasted-text" &&
              !uploadedFile.generatedTextAttachment &&
              !uploadedFile.unavailable &&
              uploadedFile.generatedTextAttachmentId
            ) {
              return [
                {
                  index,
                  attachmentId: uploadedFile.generatedTextAttachmentId,
                  fileName: uploadedFile.file.name,
                },
              ];
            }

            return [];
          })
        : [],
    [restoreDraftAttachments, uploadedFiles],
  );

  useEffect(() => {
    uploadedFilesRef.current = uploadedFiles;
  });

  useEffect(() => {
    if (!draftTextFileContents || draftTextFileContents.length === 0) {
      return;
    }

    const contentByFileId = new Map<
      string,
      { content: string; tokenSize: number }
    >(
      draftTextFileContents.flatMap((fileContent) => {
        if (!fileContent || typeof fileContent.content !== "string") {
          return [];
        }

        return [
          [
            fileContent.id as string,
            {
              content: fileContent.content,
              tokenSize: fileContent.tokenSize,
            },
          ],
        ];
      }),
    );

    if (contentByFileId.size === 0) {
      return;
    }

    let didHydrate = false;
    const nextUploadedFiles = uploadedFilesRef.current.map((uploadedFile) => {
      if (
        uploadedFile.generatedTextAttachment ||
        uploadedFile.generatedSource !== "pasted-text" ||
        !uploadedFile.fileId ||
        !uploadedFile.generatedTextAttachmentId
      ) {
        return uploadedFile;
      }

      const fileContent = contentByFileId.get(uploadedFile.fileId);
      if (!fileContent) {
        return uploadedFile;
      }

      didHydrate = true;
      return {
        ...uploadedFile,
        tokens: fileContent.tokenSize,
        generatedTextAttachment: {
          id: uploadedFile.generatedTextAttachmentId,
          content: fileContent.content,
        },
      };
    });

    if (didHydrate) {
      setUploadedFiles(nextUploadedFiles);
    }
  }, [draftTextFileContents, setUploadedFiles]);

  useEffect(() => {
    if (localDraftTextFiles.length === 0) {
      return;
    }

    let cancelled = false;

    const hydrateLocalGeneratedTextFiles = async () => {
      const hydratedFiles = await Promise.all(
        localDraftTextFiles.map(async (file) => ({
          ...file,
          content: await readGeneratedTextAttachment(
            file.attachmentId,
            file.fileName,
          ),
        })),
      );

      if (cancelled) {
        return;
      }

      let didHydrate = false;
      const hydratedByIndex = new Map(
        hydratedFiles.map((file) => [file.index, file]),
      );

      const nextUploadedFiles = uploadedFilesRef.current.map(
        (uploadedFile, index) => {
          const hydratedFile = hydratedByIndex.get(index);
          if (!hydratedFile) {
            return uploadedFile;
          }

          if (
            uploadedFile.generatedTextAttachment ||
            uploadedFile.generatedTextAttachmentId !==
              hydratedFile.attachmentId ||
            uploadedFile.storage !== "local-desktop"
          ) {
            return uploadedFile;
          }

          didHydrate = true;
          if (!hydratedFile.content) {
            return {
              ...uploadedFile,
              unavailable: true,
            };
          }

          return {
            ...uploadedFile,
            unavailable: false,
            file: {
              name: hydratedFile.content.name,
              type: hydratedFile.content.mediaType || "text/plain",
              size: hydratedFile.content.size,
              lastModified: hydratedFile.content.lastModified || Date.now(),
            },
            localAttachmentId: hydratedFile.attachmentId,
            localPath: hydratedFile.content.path,
            generatedTextAttachment: {
              id: hydratedFile.attachmentId,
              content: hydratedFile.content.content,
            },
          };
        },
      );

      if (didHydrate) {
        setUploadedFiles(nextUploadedFiles);
      }
    };

    void hydrateLocalGeneratedTextFiles();

    return () => {
      cancelled = true;
    };
  }, [localDraftTextFiles, setUploadedFiles]);

  useLayoutEffect(() => {
    const prevDraftId = prevDraftIdRef.current;
    prevDraftIdRef.current = draftId;

    if (!restoreDraftAttachments) {
      hasPersistedDraftAttachmentsRef.current = false;
      skipNextAttachmentPersistRef.current = true;
      setUploadedFiles([]);
      return;
    }

    if (prevDraftId === "new" && draftId !== "new") {
      const draftAttachments = uploadedFilesRef.current
        .map(uploadedFileToDraftAttachment)
        .filter(
          (attachment): attachment is NonNullable<typeof attachment> =>
            attachment !== null,
        );

      if (draftAttachments.length > 0) {
        upsertDraftAttachments(draftId, draftAttachments);
        removeDraftAttachments("new");
        hasPersistedDraftAttachmentsRef.current = true;
      }

      if (uploadedFilesRef.current.length > 0) {
        skipNextAttachmentPersistRef.current = true;
        return;
      }
    }

    const draftAttachments = getDraftAttachmentsById(draftId);
    hasPersistedDraftAttachmentsRef.current = draftAttachments.length > 0;
    skipNextAttachmentPersistRef.current = true;
    setUploadedFiles(draftAttachments.map(draftAttachmentToUploadedFile));
  }, [draftId, restoreDraftAttachments, setUploadedFiles]);

  useEffect(() => {
    if (skipNextAttachmentPersistRef.current) {
      skipNextAttachmentPersistRef.current = false;
      return;
    }

    if (!restoreDraftAttachments) {
      return;
    }

    const draftAttachments = uploadedFiles
      .map(uploadedFileToDraftAttachment)
      .filter(
        (attachment): attachment is NonNullable<typeof attachment> =>
          attachment !== null,
      );

    if (draftAttachments.length > 0) {
      upsertDraftAttachments(draftId, draftAttachments);
      hasPersistedDraftAttachmentsRef.current = true;
    } else if (hasPersistedDraftAttachmentsRef.current) {
      removeDraftAttachments(draftId);
      hasPersistedDraftAttachmentsRef.current = false;
    }
  }, [draftId, restoreDraftAttachments, uploadedFiles]);

  // Free agent mode constraints:
  // 1. Requires local sandbox — web users fall back to Ask if disconnected,
  //    while Desktop stays Agent-only and waits for its bridge to reconnect
  // 2. Force local sandbox preference (not e2b)
  // 3. Force auto model selection
  const isFreeAgent =
    !isCheckingProPlan && subscription === "free" && isAgentMode(chatMode);
  const freeAgentSandboxAvailable = freeDesktopAgentOnlyActive
    ? desktopBridgeStatus === "connected"
    : hasLocalSandbox;

  const prevFreeAgentSandboxAvailableRef = useRef(freeAgentSandboxAvailable);
  useEffect(() => {
    const wasConnected = prevFreeAgentSandboxAvailableRef.current;
    prevFreeAgentSandboxAvailableRef.current = freeAgentSandboxAvailable;

    if (!isFreeAgent) return;
    // Only show toast on actual disconnect (true → false), not on
    // initial mount or logout where sandbox availability starts as false.
    if (!freeAgentSandboxAvailable) {
      if (freeDesktopAgentOnlyActive) {
        if (wasConnected) {
          toast.info("Desktop sandbox disconnected.", {
            description: "Reconnect the Desktop sandbox to keep using Agent.",
            duration: 5000,
          });
        }
        return;
      }

      setChatMode("ask");
      if (wasConnected) {
        toast.info("Local sandbox disconnected. Switched to Ask mode.", {
          description: "Reconnect your sandbox to use Agent mode.",
          duration: 5000,
        });
      }
    }
  }, [
    freeAgentSandboxAvailable,
    freeDesktopAgentOnlyActive,
    isFreeAgent,
    setChatMode,
  ]);

  useEffect(() => {
    if (!isFreeAgent) return;
    if (
      (!sandboxPreference || sandboxPreference === "e2b") &&
      defaultLocalSandboxPreference
    ) {
      setSandboxPreference(defaultLocalSandboxPreference);
    }
    if (selectedModel !== "auto") {
      setSelectedModel("auto");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreeAgent]);

  const desktopSandboxUnavailableReason =
    freeDesktopAgentOnlyActive && desktopBridgeStatus !== "connected"
      ? desktopBridgeStatus === "connecting"
        ? "Desktop sandbox is connecting"
        : "Reconnect the Desktop sandbox to use Agent"
      : undefined;
  const effectiveSendDisabledReason =
    sendDisabledReason ?? desktopSandboxUnavailableReason;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || effectiveSendDisabledReason) return;

    const canSubmit =
      (status === "ready" || status === "streaming") &&
      !isUploadingFiles &&
      (input.trim() || uploadedFiles.length > 0);

    if (canSubmit) {
      const accepted = await onSubmit(e);
      if (clearDraftOnSubmit && accepted !== false) {
        removeDraft(draftId);
        setTimeout(() => setInput(""), 0);
      }
    }
  };

  const handleOfflineReconnect = async () => {
    if (isReconnecting) return;

    setIsReconnecting(true);
    try {
      const reconnected = await reconnectOnlineStatus();
      if (!reconnected) {
        toast.info("Still offline", {
          description: "Check your connection, then try reconnecting again.",
        });
        return;
      }
      await onReconnect?.();
    } catch {
      toast.error("Could not reconnect the chat", {
        description: "Your draft is still saved. Please try again.",
      });
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleShowGeneratedTextInField = async (
    index: number,
    content: string,
  ) => {
    if (content.length > PASTED_TEXT_INLINE_RESTORE_MAX_CHARS) {
      toast.error("Pasted text is too long to show in the text field", {
        description: "Edit it below 25,000 characters and try again.",
      });
      return;
    }

    const separator =
      input.length === 0 ? "" : input.endsWith("\n") ? "\n" : "\n\n";
    setInput(`${input}${separator}${content}`);
    await handleRemoveFile(index);
  };

  if (isResolvingInitialState) {
    return <ChatInputLoadingState showAgentControls={isAgent} />;
  }

  return (
    <div className={`relative px-4 min-w-0 ${isCentered ? "" : "pb-3"}`}>
      <div className="mx-auto w-full max-w-full min-w-0 sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        {isOffline && (
          <div
            role="status"
            aria-live="polite"
            data-testid="offline-status"
            className="mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-foreground sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <WifiOff
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
              />
              <p>
                You&apos;re offline. Keep typing—this draft will stay on this
                device.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full shrink-0 sm:w-auto"
              disabled={isReconnecting}
              onClick={() => void handleOfflineReconnect()}
            >
              {isReconnecting ? "Reconnecting..." : "Reconnect"}
            </Button>
          </div>
        )}

        {rateLimitWarning && onDismissRateLimitWarning && (
          <RateLimitWarning
            data={rateLimitWarning}
            onDismiss={onDismissRateLimitWarning}
          />
        )}

        <div className="flex flex-col [&>*+*]:rounded-t-none">
          <TodoPanel status={status} />

          {messageQueue.length > 0 && (
            <QueuedMessagesPanel
              messages={messageQueue}
              onSendNow={onSendNow}
              onEdit={updateQueuedMessage}
              onEditingMessageChange={setEditingQueuedMessageId}
              onDelete={removeQueuedMessage}
              isStreaming={status === "streaming"}
              queueBehavior={queueBehavior}
              onQueueBehaviorChange={setQueueBehavior}
            />
          )}
        </div>

        {uploadedFiles && uploadedFiles.length > 0 && (
          <FileUploadPreview
            uploadedFiles={uploadedFiles}
            onRemoveFile={handleRemoveFile}
            onUpdateGeneratedTextFile={handleUpdateGeneratedTextFile}
            onShowGeneratedTextInField={handleShowGeneratedTextInField}
            generatedTextAttachmentsAvailable={isAgent}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="*"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={handleFileUploadEvent}
        />

        {showAgentApprovalPrompt ? (
          <AgentApprovalPrompt
            request={approvalRequest}
            hasConnectionError={status === "error"}
            onRetryConnection={onReconnect}
            onStop={() => void handleAgentStop()}
          />
        ) : (
          <div
            className={`chat-input-glass-surface relative z-10 order-2 flex max-h-[300px] min-w-0 flex-col gap-3 overflow-hidden border border-black/8 py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] transition-colors sm:order-1 dark:border-border ${uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
            data-testid="chat-input-surface"
          >
            <ChatInputTextarea
              draftId={draftId}
              chatMode={chatMode}
              onEnterSubmit={handleSubmit}
              minRows={isCentered ? 3 : 1}
              placeholder={placeholder}
              autoFocus={autoFocus}
            />
            <ChatInputToolbar
              onAttachClick={handleAttachClick}
              isGenerating={isGenerating}
              hideStop={hideStop}
              onStop={() => void handleAgentStop()}
              onSubmit={handleSubmit}
              status={status}
              isUploadingFiles={isUploadingFiles}
              input={input}
              uploadedFiles={uploadedFiles}
              chatMode={chatMode}
              isOnline={!isOffline}
              sendDisabledReason={effectiveSendDisabledReason}
            />
          </div>
        )}

        {/* Compact mobile Agent controls below the input. Desktop keeps these
            selectors in the main toolbar where there is room for them. */}
        {isAgent && !showAgentApprovalPrompt && (
          <div
            className="chat-input-glass-context relative z-0 order-3 mx-6 -mt-2 flex h-10 min-w-0 items-center gap-2 rounded-b-[18px] border border-t-0 border-black/8 px-3 pt-2 md:hidden dark:border-border/70"
            data-testid="chat-input-agent-context"
          >
            <SandboxSelector
              value={sandboxPreference}
              onChange={setSandboxPreference}
            />
            <div
              className="ml-auto min-w-0 md:hidden"
              data-testid="chat-input-mobile-permission"
            >
              <AgentPermissionSelector analyticsSurface="chat_input" />
            </div>
          </div>
        )}

        {onScrollToBottom && (
          <div className="absolute -top-16 left-1/2 -translate-x-1/2 z-40">
            <ScrollToBottomButton
              onClick={onScrollToBottom}
              hasMessages={hasMessages}
              isAtBottom={isAtBottom}
            />
          </div>
        )}
      </div>
    </div>
  );
};
