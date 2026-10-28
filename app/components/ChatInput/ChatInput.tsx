"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RegionalSubscriptionGate } from "../RegionalSubscriptionGate";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  useComposerActions,
  useComposerInput,
} from "@/app/contexts/ComposerState";
import { TodoPanel } from "../TodoPanel";
import { getTodoPanelViewState } from "@/lib/utils/todo-utils";
import type { ChatStatus } from "@/types";
import { FileUploadPreview } from "../FileUploadPreview";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import {
  isTauriEnvironment,
  readGeneratedTextAttachment,
} from "@/app/hooks/useTauri";
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
import { requestRemoteConnectionSelection } from "@/app/hooks/useAutoSelectNewRemoteConnection";
import { isDesktopPreference } from "@/lib/sandbox/environment";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { isFreeDesktopSandboxAvailable } from "@/lib/activation/free-desktop-sandbox";
import { useSelectedComputerConnection } from "@/app/hooks/useSelectedComputerConnection";
import { DisconnectedComputerNotice } from "./DisconnectedComputerNotice";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

interface ChatInputProps {
  onSubmit: (e: React.FormEvent) => void | boolean | Promise<void | boolean>;
  onStop: () => void | boolean | Promise<void | boolean>;
  onReconnect?: () => void | Promise<void>;
  onSendNow: (messageId: string) => void;
  status: ChatStatus;
  isCentered?: boolean;
  hasMessages?: boolean;
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

const COMPACT_AGENT_CONTROLS_BREAKPOINT_PX = 720;

const shouldUseCompactAgentControls = (width: number): boolean =>
  width > 0 && width < COMPACT_AGENT_CONTROLS_BREAKPOINT_PX;

const ChatInputLoadingState = () => (
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

export const ChatInput = (props: ChatInputProps) => {
  const { activeToolApprovalRequest } = useAgentApproval();
  return (
    <RegionalSubscriptionGate
      running={
        props.status === "submitted" ||
        props.status === "streaming" ||
        !!activeToolApprovalRequest ||
        !!props.storedApprovalRequest
      }
    >
      <ChatInputContent {...props} />
    </RegionalSubscriptionGate>
  );
};

const ChatInputContent = ({
  onSubmit,
  onStop,
  onReconnect,
  onSendNow,
  status,
  isCentered = false,
  hasMessages = false,
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
    getUploadedFiles,
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
    localConnections,
    freeDesktopAgentOnlyActive,
    desktopBridgeStatus,
    retryDesktopBridge,
    defaultLocalSandboxPreference,
    todos,
    sidebarOpen,
  } = useGlobalState();
  const { user } = useAuth();
  const input = useComposerInput();
  const { setInput, getInput } = useComposerActions();
  const isOnline = useOnlineStatus();
  const isOffline = offlineProtection && !isOnline;
  const {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleRetryFile,
    handleUpdateGeneratedTextFile,
    handleAttachClick,
  } = useFileUpload(chatMode);
  const { activeToolApprovalRequest } = useAgentApproval();

  const isGenerating = status === "submitted" || status === "streaming";
  const isAgent = isAgentMode(chatMode);
  const isEmptyNewChat = isNewChat && !hasMessages;
  const todoPanelVisible =
    !sidebarOpen && getTodoPanelViewState(todos, status).hasActiveTodos;
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
  const [compactAgentControls, setCompactAgentControls] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const isMobile = useIsMobile();
  const sandboxInactive = !isEmptyNewChat && !composerFocused;
  const mobileSandboxHidden = isMobile === true && sandboxInactive;
  const chatInputContainerRef = useRef<HTMLDivElement>(null);
  const composerPointerDownRef = useRef(false);
  const composerPointerReleaseTimerRef = useRef<number | undefined>(undefined);
  const holdComposerFocusForPointer = () => {
    window.clearTimeout(composerPointerReleaseTimerRef.current);
    composerPointerDownRef.current = true;
  };
  const showAgentApprovalPrompt =
    !!user && !!approvalRequest && !isStoppingAgent;
  const hasJoinedComposerPanels =
    !!user &&
    !showAgentApprovalPrompt &&
    (todoPanelVisible || messageQueue.length > 0);
  const hasFilePreviews = !!uploadedFiles?.length;

  useEffect(() => {
    const releasePointer = () => {
      if (!composerPointerDownRef.current) return;
      window.clearTimeout(composerPointerReleaseTimerRef.current);
      // Keep the guard through the release event's blur/click sequence.
      composerPointerReleaseTimerRef.current = window.setTimeout(() => {
        composerPointerDownRef.current = false;
        const activeElement = document.activeElement;
        const focusInComposer =
          activeElement instanceof Node &&
          chatInputContainerRef.current?.contains(activeElement);
        const agentMenuOpen = document.querySelector(
          "[data-chat-input-agent-menu]",
        );
        if (!focusInComposer && !agentMenuOpen) setComposerFocused(false);
      }, 0);
    };
    document.addEventListener("pointerup", releasePointer);
    document.addEventListener("pointercancel", releasePointer);
    return () => {
      document.removeEventListener("pointerup", releasePointer);
      document.removeEventListener("pointercancel", releasePointer);
      window.clearTimeout(composerPointerReleaseTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const container = chatInputContainerRef.current;
    if (!container) return;

    const updateCompactLayout = (width: number) => {
      const nextCompact = shouldUseCompactAgentControls(width);
      setCompactAgentControls((current) =>
        current === nextCompact ? current : nextCompact,
      );
    };

    updateCompactLayout(container.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateCompactLayout(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isGenerating && !activeToolApprovalRequest && !storedApprovalRequest) {
      setIsStoppingAgent(false);
    }
  }, [activeToolApprovalRequest, isGenerating, storedApprovalRequest]);

  useEffect(() => {
    if (!composerFocused) return;
    const dismissOutsideComposer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (chatInputContainerRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest("[data-chat-input-agent-menu]")
      )
        return;
      composerPointerDownRef.current = false;
      setComposerFocused(false);
    };
    document.addEventListener("pointerdown", dismissOutsideComposer);
    document.addEventListener("focusin", dismissOutsideComposer);
    return () => {
      document.removeEventListener("pointerdown", dismissOutsideComposer);
      document.removeEventListener("focusin", dismissOutsideComposer);
    };
  }, [composerFocused]);

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

  const draftId = isEmptyNewChat ? "new" : chatId || NULL_THREAD_DRAFT_ID;
  const skipNextAttachmentPersistRef = useRef(false);
  const hasPersistedDraftAttachmentsRef = useRef(false);
  const isSubmittingAttachmentsRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const isMountedRef = useRef(true);
  const uploadedFilesRef = useRef(uploadedFiles);
  const prevDraftIdRef = useRef(draftId);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
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

  useLayoutEffect(() => {
    uploadedFilesRef.current = uploadedFiles;
  }, [uploadedFiles]);

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
      if (isSubmittingAttachmentsRef.current) {
        uploadedFilesRef.current = [];
        removeDraft("new");
        removeDraft(draftId);
        hasPersistedDraftAttachmentsRef.current = false;
        skipNextAttachmentPersistRef.current = true;
        isSubmittingAttachmentsRef.current = false;
        return;
      }

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
  // 1. Requires a connected local sandbox — Desktop may use either its
  //    built-in bridge or a separately connected local runner
  // 2. Force local sandbox preference (not e2b)
  // 3. Force auto model selection
  const isFreeAgent =
    !!user &&
    !isCheckingProPlan &&
    subscription === "free" &&
    isAgentMode(chatMode) &&
    (!isTauriEnvironment() || freeDesktopAgentOnlyActive);
  const freeAgentSandboxAvailable = freeDesktopAgentOnlyActive
    ? isFreeDesktopSandboxAvailable({
        sandboxPreference,
        desktopBridgeActive: desktopBridgeStatus === "connected",
        localConnections,
      })
    : hasLocalSandbox;

  const prevFreeAgentSandboxRef = useRef({
    sandboxPreference,
    available: freeAgentSandboxAvailable,
    isFreeAgent,
  });
  useEffect(() => {
    const previous = prevFreeAgentSandboxRef.current;
    const wasConnected =
      previous.isFreeAgent &&
      previous.sandboxPreference === sandboxPreference &&
      previous.available;
    prevFreeAgentSandboxRef.current = {
      sandboxPreference,
      available: freeAgentSandboxAvailable,
      isFreeAgent,
    };

    if (!isFreeAgent) return;
    // Only warn when the same selected sandbox loses availability. Restoring a
    // different task or resolving plan access is not a connection lifecycle event.
    if (!freeAgentSandboxAvailable) {
      if (freeDesktopAgentOnlyActive || sandboxPreference !== "e2b") {
        if (wasConnected) {
          const selectedDesktop = isDesktopPreference(sandboxPreference);
          toast.info(
            selectedDesktop
              ? "Desktop sandbox disconnected."
              : "Local sandbox disconnected.",
            {
              description: selectedDesktop
                ? "Reconnect the Desktop sandbox to keep using Agent."
                : "Reconnect the selected local runner to keep using Agent.",
              duration: 5000,
            },
          );
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
    sandboxPreference,
    setChatMode,
  ]);

  useEffect(() => {
    if (!isFreeAgent) return;
    if (
      (!sandboxPreference || sandboxPreference === "e2b") &&
      defaultLocalSandboxPreference
    ) {
      setSandboxPreference(defaultLocalSandboxPreference, { remember: false });
    }
    if (selectedModel !== "auto") {
      setSelectedModel("auto");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFreeAgent]);

  const freeDesktopSandboxUnavailableReason =
    freeDesktopAgentOnlyActive && !freeAgentSandboxAvailable
      ? isDesktopPreference(sandboxPreference)
        ? desktopBridgeStatus === "connecting"
          ? "Desktop sandbox is reconnecting"
          : "Reconnect the Desktop sandbox to use Agent"
        : sandboxPreference === "e2b"
          ? "Select a local sandbox to use Agent"
          : "Reconnect the selected local sandbox to use Agent"
      : undefined;
  const {
    selectedNativeDesktop,
    computerConnectionPending,
    selectedComputerUnavailable,
    sendDisabledReason: computerSendDisabledReason,
  } = useSelectedComputerConnection();
  const effectiveSendDisabledReason =
    sendDisabledReason ??
    (user
      ? (freeDesktopSandboxUnavailableReason ?? computerSendDisabledReason)
      : undefined);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    if (isOffline || effectiveSendDisabledReason) return;

    const canSubmit =
      (status === "ready" ||
        status === "submitted" ||
        status === "streaming") &&
      !isUploadingFiles &&
      (input.trim() || uploadedFiles.length > 0);

    if (canSubmit) {
      isSubmittingRef.current = true;
      const submittedInput = getInput();
      const submittedFiles = getUploadedFiles();
      try {
        isSubmittingAttachmentsRef.current =
          clearDraftOnSubmit && uploadedFiles.length > 0;
        const accepted = await onSubmit(e);
        if (!isMountedRef.current) return;
        const unchanged =
          getInput() === submittedInput &&
          getUploadedFiles() === submittedFiles;
        // The chat handler can already have cleared the accepted submission.
        const alreadyCleared =
          getInput() === "" && getUploadedFiles().length === 0;
        const sameDraft =
          prevDraftIdRef.current === draftId ||
          (draftId === "new" && prevDraftIdRef.current === chatId);
        if (
          accepted === false ||
          !sameDraft ||
          (!unchanged && !alreadyCleared)
        ) {
          isSubmittingAttachmentsRef.current = false;
          return;
        }
        if (clearDraftOnSubmit) {
          uploadedFilesRef.current = [];
          removeDraft(draftId);
          if (draftId === "new" && chatId) {
            removeDraft(chatId);
          }
          if (draftId !== "new") {
            isSubmittingAttachmentsRef.current = false;
          }
          setInput("");
        }
      } catch (error) {
        isSubmittingAttachmentsRef.current = false;
        console.error("Failed to submit message:", error);
      } finally {
        isSubmittingRef.current = false;
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
    return <ChatInputLoadingState />;
  }

  return (
    <div
      className={`relative flex max-h-[calc(100dvh-4rem)] min-h-0 min-w-0 flex-col px-4 ${isCentered ? "" : "pb-3"}`}
    >
      <div
        ref={chatInputContainerRef}
        className="mx-auto flex min-h-0 w-full min-w-0 max-w-full flex-1 flex-col sm:min-w-[390px] sm:max-w-[768px]"
        data-testid="chat-input-container"
      >
        {/* Panels keep their content height and scroll as a stack instead of
            shrinking beneath the next panel. Reserve the input or approval card. */}
        <div
          className={`flex min-h-0 shrink-0 flex-col overflow-y-auto [&>*]:shrink-0 ${showAgentApprovalPrompt ? "max-h-[25dvh]" : "max-h-[calc(100dvh-11rem)]"} ${hasJoinedComposerPanels && !hasFilePreviews ? "-mb-5 md:mb-0" : ""}`}
        >
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

          {user &&
            selectedComputerUnavailable &&
            !computerConnectionPending && (
              <DisconnectedComputerNotice
                isNewChat={isNewChat}
                sandboxPreference={sandboxPreference}
                onSelect={setSandboxPreference}
                reconnectInstructions={
                  isDesktopPreference(sandboxPreference) &&
                  !selectedNativeDesktop
                    ? "Open HackerAI Desktop on your selected computer and sign in with the same account. Keep the app open while it reconnects."
                    : undefined
                }
                reconnecting={
                  selectedNativeDesktop && desktopBridgeStatus === "connecting"
                }
                onReconnect={() => {
                  if (selectedNativeDesktop) retryDesktopBridge();
                  else {
                    requestRemoteConnectionSelection(sandboxPreference);
                    openSettingsDialog("Remote Control");
                  }
                }}
              />
            )}

          {user && rateLimitWarning && onDismissRateLimitWarning && (
            <RateLimitWarning
              data={rateLimitWarning}
              onDismiss={onDismissRateLimitWarning}
              compact={todoPanelVisible}
            />
          )}

          {/* Keep the row's geometry fixed when an existing mobile chat hides
              its selector, so focus changes never move the composer. */}
          {user && isAgent && !showAgentApprovalPrompt && (
            <div
              className={`relative z-0 mb-1 flex min-w-0 shrink-0 touch-manipulation items-center justify-end px-2 ${compactAgentControls ? "" : "md:hidden"} ${sandboxInactive ? "invisible pointer-events-none md:visible md:pointer-events-auto" : ""}`}
              data-compact={compactAgentControls ? "true" : "false"}
              data-testid="chat-input-agent-context"
              aria-hidden={mobileSandboxHidden || undefined}
              inert={mobileSandboxHidden || undefined}
              onPointerDownCapture={holdComposerFocusForPointer}
            >
              <div
                className="min-w-0 max-w-full"
                data-testid="chat-input-mobile-sandbox"
              >
                <SandboxSelector
                  value={sandboxPreference}
                  onChange={setSandboxPreference}
                  compact
                  size="sm"
                  menuAlign="end"
                />
              </div>
            </div>
          )}

          {user && (
            <div
              className={`flex flex-col [&>*+*]:rounded-t-none ${hasJoinedComposerPanels ? "[&>*:last-child]:pb-[19px] md:[&>*:last-child]:pb-0" : ""} ${hasJoinedComposerPanels && hasFilePreviews ? "-mb-5 md:mb-0" : ""}`}
            >
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
          )}

          {uploadedFiles && uploadedFiles.length > 0 && (
            <div className="order-2 shrink-0">
              <FileUploadPreview
                uploadedFiles={uploadedFiles}
                onRemoveFile={handleRemoveFile}
                onRetryFile={handleRetryFile}
                onUpdateGeneratedTextFile={handleUpdateGeneratedTextFile}
                onShowGeneratedTextInField={handleShowGeneratedTextInField}
                generatedTextAttachmentsAvailable={isAgent}
              />
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
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
            className={`chat-input-glass-surface relative z-10 order-2 flex max-h-[300px] min-h-[96px] min-w-0 touch-manipulation flex-col gap-3 overflow-hidden border border-black/8 py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] transition-colors dark:border-border ${uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
            data-testid="chat-input-surface"
            data-panels-joined={hasJoinedComposerPanels || undefined}
            onFocusCapture={() => setComposerFocused(true)}
            onPointerDownCapture={() => {
              setComposerFocused(true);
              holdComposerFocusForPointer();
            }}
          >
            <ChatInputTextarea
              draftId={draftId}
              chatMode={chatMode}
              onEnterSubmit={handleSubmit}
              minRows={isCentered ? 3 : 1}
              placeholder={placeholder}
              autoFocus={autoFocus}
              onBlur={(event) => {
                if (composerPointerDownRef.current) return;
                const next = event.relatedTarget;
                if (
                  next instanceof Node &&
                  (chatInputContainerRef.current?.contains(next) ||
                    (next instanceof Element &&
                      next.closest("[data-chat-input-agent-menu]")))
                )
                  return;
                setComposerFocused(false);
              }}
            />
            <ChatInputToolbar
              compactAgentControls={compactAgentControls}
              onAttachClick={handleAttachClick}
              isGenerating={isGenerating}
              hideStop={hideStop}
              onStop={() => void handleAgentStop()}
              onSubmit={handleSubmit}
              status={status}
              isUploadingFiles={isUploadingFiles}
              input={input}
              uploadedFiles={uploadedFiles}
              chatMode={user ? chatMode : "ask"}
              isOnline={!isOffline}
              sendDisabledReason={effectiveSendDisabledReason}
            />
          </div>
        )}
      </div>
    </div>
  );
};
