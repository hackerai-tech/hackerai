"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
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

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void | boolean | Promise<void | boolean>;
  onStop: () => void | boolean | Promise<void | boolean>;
  onReconnect?: () => void;
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
}

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
}: ChatInputProps) => {
  const {
    input,
    setInput,
    chatMode,
    setChatMode,
    uploadedFiles,
    setUploadedFiles,
    isUploadingFiles,
    messageQueue,
    removeQueuedMessage,
    queueBehavior,
    setQueueBehavior,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
    subscription,
    isCheckingProPlan,
    temporaryChatsEnabled,
    hasLocalSandbox,
    defaultLocalSandboxPreference,
  } = useGlobalState();
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
  const approvalRequest = activeToolApprovalRequest ?? storedApprovalRequest;
  const [isStoppingAgent, setIsStoppingAgent] = useState(false);
  const showAgentApprovalPrompt = !!approvalRequest && !isStoppingAgent;

  useEffect(() => {
    if (!isGenerating && !approvalRequest) {
      setIsStoppingAgent(false);
    }
  }, [approvalRequest, isGenerating]);

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
    isNewChat && (!hasMessages || temporaryChatsEnabled)
      ? "new"
      : chatId || NULL_THREAD_DRAFT_ID;
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

  useEffect(() => {
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
  // 1. Requires local sandbox — fall back to ask mode if disconnected
  // 2. Force local sandbox preference (not e2b)
  // 3. Force auto model selection
  const isFreeAgent =
    !isCheckingProPlan && subscription === "free" && isAgentMode(chatMode);

  const prevHasLocalSandboxRef = useRef(hasLocalSandbox);
  useEffect(() => {
    const wasConnected = prevHasLocalSandboxRef.current;
    prevHasLocalSandboxRef.current = hasLocalSandbox;

    if (!isFreeAgent) return;
    // Only show toast on actual disconnect (true → false), not on
    // initial mount or logout where hasLocalSandbox starts as false.
    if (!hasLocalSandbox) {
      setChatMode("ask");
      if (wasConnected) {
        toast.info("Local sandbox disconnected. Switched to Ask mode.", {
          description: "Reconnect your sandbox to use Agent mode.",
          duration: 5000,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreeAgent, hasLocalSandbox]);

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

  // Fallback to 'ask' mode when temporary chats are enabled (agent modes not allowed)
  useEffect(() => {
    if (temporaryChatsEnabled && isAgentMode(chatMode)) {
      setChatMode("ask");
    }
  }, [temporaryChatsEnabled, chatMode, setChatMode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

  return (
    <div className={`relative px-4 min-w-0 ${isCentered ? "" : "pb-3"}`}>
      <div className="mx-auto w-full max-w-full min-w-0 sm:max-w-[768px] sm:min-w-[390px] flex flex-col flex-1">
        {rateLimitWarning && onDismissRateLimitWarning && (
          <RateLimitWarning
            data={rateLimitWarning}
            onDismiss={onDismissRateLimitWarning}
          />
        )}

        <TodoPanel status={status} />

        {messageQueue.length > 0 && (
          <QueuedMessagesPanel
            messages={messageQueue}
            onSendNow={onSendNow}
            onDelete={removeQueuedMessage}
            isStreaming={status === "streaming"}
            queueBehavior={queueBehavior}
            onQueueBehaviorChange={setQueueBehavior}
          />
        )}

        {uploadedFiles && uploadedFiles.length > 0 && (
          <FileUploadPreview
            uploadedFiles={uploadedFiles}
            onRemoveFile={handleRemoveFile}
            onUpdateGeneratedTextFile={handleUpdateGeneratedTextFile}
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
            className={`order-2 sm:order-1 flex flex-col gap-3 transition-colors relative bg-input-chat py-3 max-h-[300px] min-w-0 overflow-hidden shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border ${uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
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
            />
          </div>
        )}

        {/* Agent controls below input.
            Desktop centered new chats (no messages yet): absolutely positioned to avoid
            shifting the centered layout.
            On mobile, permission approval sits beside the sandbox selector. */}
        {isAgent && !showAgentApprovalPrompt && (
          <div
            className={`order-3 flex items-center gap-2 px-1 pt-2 min-w-0 ${
              isNewChat && !hasMessages
                ? "md:absolute md:left-4 md:right-4 md:top-full"
                : ""
            }`}
          >
            <SandboxSelector
              value={sandboxPreference}
              onChange={setSandboxPreference}
            />
            <div className="min-w-0 md:hidden">
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
