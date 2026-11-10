"use client";

import {
  userInputQuestionsSchema,
  type UserInputQuestion,
} from "@/lib/chat/user-input-questions";
import { useQuestionAnswers } from "./useQuestionAnswers";
import { UserInputQuestionPanel } from "./UserInputQuestionPanel";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNextActions } from "@/app/hooks/useNextActions";
import { useLatestRef } from "@/app/hooks/useLatestRef";
import type { CompletedPredictionTurn } from "@/lib/chat/next-actions/contracts";
import { RegionalSubscriptionGate } from "../RegionalSubscriptionGate";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  useComposerActions,
  useComposerInput,
  useComposerGoalMode,
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
  getDraftContentById,
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
import { GoalSubmissionUnconfirmedError } from "@/lib/chat/goal-submission";
import { NULL_THREAD_DRAFT_ID } from "@/lib/utils/client-storage";
import { SandboxSelector } from "../SandboxSelector";
import { ChatInputTextarea } from "./ChatInputTextarea";
import { ChatInputToolbar } from "./ChatInputToolbar";
import { AgentApprovalPrompt } from "./AgentApprovalPrompt";
import {
  WaitingForReplyBanner,
  WAITING_FOR_REPLY_DESCRIPTION_ID,
} from "./WaitingForReplyBanner";
import {
  AgentReplyConflictError,
  type ActiveAgentUserWait,
} from "@/lib/chat/agent-user-wait";
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
import { GoalTargetIcon } from "@/components/icons/goal-target";
import { GoalModeButton } from "./GoalModeButton";
import { getGoalSuggestionDraft } from "./goal-suggestion";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { useIsMobile } from "@/hooks/use-mobile";
import { isFreeDesktopSandboxAvailable } from "@/lib/activation/free-desktop-sandbox";
import { useSelectedComputerConnection } from "@/app/hooks/useSelectedComputerConnection";
import { DisconnectedComputerNotice } from "./DisconnectedComputerNotice";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

interface ChatInputProps {
  completedPredictionTurn?: CompletedPredictionTurn | null;
  interruptedPredictionTurn?: { chatId: string } | null;
  latestMessageId?: string;
  latestMessageIsAssistant?: boolean;
  predictionModeReady?: boolean;
  goalPanel?: (placement: "attached" | "detached") => React.ReactNode;
  hasActiveGoalRun?: boolean;
  pauseGoalOnSend?: boolean;
  onSubmit: (
    e: React.FormEvent,
    inputOverride?: string,
    structuredReply?: boolean,
  ) => void | boolean | Promise<void | boolean>;
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
  pendingUserWait?: ActiveAgentUserWait | null;
  pendingGoalQuestions?: { generation: number; questions: UserInputQuestion[] };
  offlineProtection?: boolean;
  sendDisabledReason?: string;
  isResolvingInitialState?: boolean;
  topNotice?: React.ReactNode;
}

const COMPOSER_TAP_CLICK_FALLBACK_MS = 500;
// Prose-only waits use the same isolated draft without displaying a question panel.
const PLAIN_REPLY_QUESTIONS: UserInputQuestion[] = [
  { id: "reply", header: "Reply", question: "Your reply", options: [] },
];

const ChatInputLoadingState = ({
  topNotice,
}: Pick<ChatInputProps, "topNotice">) => (
  <div
    aria-label="Loading task input"
    aria-live="polite"
    className="relative min-w-0 px-4 pb-3"
    data-testid="chat-input-loading-state"
    role="status"
  >
    <div className="mx-auto w-full min-w-0 max-w-full sm:max-w-[768px]">
      <div className="max-h-[calc(100dvh-11rem)] overflow-y-auto md:bg-background">
        {topNotice}
      </div>
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
  const { editingQueuedMessageId } = useGlobalState();
  return (
    <RegionalSubscriptionGate
      fallbackHeader={
        props.topNotice ? (
          <div className="mx-auto w-full max-w-[800px] px-4">
            {props.topNotice}
          </div>
        ) : undefined
      }
      running={
        !!props.hasActiveGoalRun ||
        props.status === "submitted" ||
        props.status === "streaming" ||
        !!props.pendingUserWait ||
        !!activeToolApprovalRequest ||
        !!props.storedApprovalRequest ||
        !!editingQueuedMessageId
      }
    >
      <ChatInputContent {...props} />
    </RegionalSubscriptionGate>
  );
};

const ChatInputContent = ({
  completedPredictionTurn,
  interruptedPredictionTurn,
  latestMessageId,
  latestMessageIsAssistant,
  predictionModeReady = true,
  goalPanel,
  hasActiveGoalRun = false,
  pauseGoalOnSend = false,
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
  pendingUserWait,
  pendingGoalQuestions,
  offlineProtection = true,
  sendDisabledReason,
  isResolvingInitialState = false,
  topNotice,
}: ChatInputProps) => {
  const {
    chatMode,
    chatModeAccessResolved,
    setChatMode,
    uploadedFiles,
    getUploadedFiles,
    setUploadedFiles,
    isUploadingFiles,
    messageQueue,
    updateQueuedMessage,
    editingQueuedMessageId,
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

  const isGenerating =
    hasActiveGoalRun || status === "submitted" || status === "streaming";
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
  const [submissionPending, setSubmissionPending] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const isMobile = useIsMobile();
  const sandboxInactive = !isEmptyNewChat && !composerFocused;
  const mobileSandboxHidden = isMobile === true && sandboxInactive;
  const chatInputContainerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerPointerDownRef = useRef(false);
  const composerPointerReleaseTimerRef = useRef<number | undefined>(undefined);
  const holdComposerFocusForPointer = () => {
    window.clearTimeout(composerPointerReleaseTimerRef.current);
    composerPointerDownRef.current = true;
  };

  const showAgentApprovalPrompt =
    !!user && !!approvalRequest && !isStoppingAgent;
  const isWaitingForReply =
    !!user &&
    (!!pendingUserWait || !!pendingGoalQuestions) &&
    !showAgentApprovalPrompt;
  const questionSource =
    pendingUserWait?.questions ?? pendingGoalQuestions?.questions;
  const questions = useMemo(() => {
    const parsed = userInputQuestionsSchema.safeParse(questionSource);
    return parsed.success ? parsed.data : [];
  }, [questionSource]);
  const questionKey =
    isWaitingForReply && user
      ? `hackerai-question:${user.id}:${chatId}:${pendingUserWait ? `${pendingUserWait.runId}:${pendingUserWait.toolCallId}` : `goal:${pendingGoalQuestions!.generation}`}`
      : undefined;
  const answerQuestions = questions.length ? questions : PLAIN_REPLY_QUESTIONS;
  const questionAnswers = useQuestionAnswers(
    questionKey,
    answerQuestions,
    pendingUserWait?.status === "submitting",
  );
  const hasQuestionPanel = !!questionKey && questions.length > 0;
  const exposedQuestionPanelsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      !hasQuestionPanel ||
      !questionKey ||
      exposedQuestionPanelsRef.current.has(questionKey)
    )
      return;
    if (
      captureAuthenticatedEvent("agent_input_questions_exposed", {
        definition_version: 1,
        source: pendingUserWait ? "wait_for_user" : "goal",
        question_count: questions.length,
      })
    )
      exposedQuestionPanelsRef.current.add(questionKey);
  }, [questionKey, pendingUserWait, questions.length, hasQuestionPanel]);
  const exposedUserWaitsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isWaitingForReply || !pendingUserWait) return;
    const key = `${pendingUserWait.runId}:${pendingUserWait.toolCallId}`;
    if (exposedUserWaitsRef.current.has(key)) return;
    exposedUserWaitsRef.current.add(key);
    captureAuthenticatedEvent("agent_wait_for_user_exposed", {
      definition_version: 1,
    });
  }, [isWaitingForReply, pendingUserWait]);
  const hasJoinedComposerPanels =
    !!user &&
    !showAgentApprovalPrompt &&
    (todoPanelVisible || messageQueue.length > 0 || isWaitingForReply);
  const hasFilePreviews = !!uploadedFiles?.length;
  const goalPlacement =
    isMobile === true ||
    showAgentApprovalPrompt ||
    hasJoinedComposerPanels ||
    hasFilePreviews
      ? "detached"
      : "attached";

  useEffect(() => {
    const releasePointer = (delay: number) => {
      if (!composerPointerDownRef.current) return;
      window.clearTimeout(composerPointerReleaseTimerRef.current);
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
      }, delay);
    };
    // Touch compatibility mouse events can blur the input after pointerup.
    // Keep the selector interactive until click opens its menu. Release a
    // canceled gesture immediately, or a gesture with no click after a fallback.
    const releaseAfterClick = () => releasePointer(0);
    const releaseWithoutClick = () =>
      releasePointer(COMPOSER_TAP_CLICK_FALLBACK_MS);
    document.addEventListener("pointerup", releaseWithoutClick);
    document.addEventListener("pointercancel", releaseAfterClick);
    document.addEventListener("click", releaseAfterClick);
    return () => {
      document.removeEventListener("pointerup", releaseWithoutClick);
      document.removeEventListener("pointercancel", releaseAfterClick);
      document.removeEventListener("click", releaseAfterClick);
      window.clearTimeout(composerPointerReleaseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (
      !isGenerating &&
      !isWaitingForReply &&
      !activeToolApprovalRequest &&
      !storedApprovalRequest
    ) {
      setIsStoppingAgent(false);
    }
  }, [
    activeToolApprovalRequest,
    isGenerating,
    isWaitingForReply,
    storedApprovalRequest,
  ]);

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
  const [goalMode, setGoalMode] = useComposerGoalMode(draftId);
  const [goalEnabled, setGoalEnabled] = useState<boolean | null>(null);
  const [dismissedGoalSuggestionInput, setDismissedGoalSuggestionInput] =
    useState<string | null>(null);
  useEffect(() => {
    setGoalEnabled(null);
    // Entitlements and the saved chat mode hydrate after the first render.
    // Do not erase a restored goal draft while that state is unresolved.
    if (!chatModeAccessResolved || isCheckingProPlan || isResolvingInitialState)
      return;
    if (chatMode !== "agent" || subscription === "free") {
      setGoalMode(false);
      return;
    }
    const abort = new AbortController();
    fetch("/api/agent-goal", { signal: abort.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!abort.signal.aborted) setGoalEnabled(data?.enabled === true);
      })
      .catch(() => {
        if (!abort.signal.aborted) setGoalEnabled(false);
      });
    return () => abort.abort();
  }, [
    chatId,
    chatMode,
    chatModeAccessResolved,
    isCheckingProPlan,
    isResolvingInitialState,
    subscription,
    setGoalMode,
  ]);
  const goalSendDisabledReason =
    goalMode && !goalEnabled
      ? goalEnabled === false
        ? "Goal mode is unavailable. Exit goal mode to send a normal message."
        : "Checking goal availability…"
      : undefined;
  const effectiveSendDisabledReason =
    (submissionPending ? "Sending message…" : undefined) ??
    (uploadedFiles.some((file) => file.removing)
      ? "Wait for the attachment to finish removing."
      : undefined) ??
    (isWaitingForReply
      ? uploadedFiles.length > 0
        ? "Remove attachments to reply"
        : pendingUserWait
          ? undefined
          : sendDisabledReason
      : sendDisabledReason) ??
    (isWaitingForReply ? undefined : goalSendDisabledReason) ??
    (status === "ready" && editingQueuedMessageId
      ? "Finish editing the queued message before sending a new request"
      : undefined) ??
    (user && !pendingUserWait
      ? (freeDesktopSandboxUnavailableReason ?? computerSendDisabledReason)
      : undefined);

  useEffect(() => {
    // A no-op setter after every edit leaves synchronous work pending during
    // native input bursts and can trip React's nested-update limit.
    if (
      dismissedGoalSuggestionInput !== null &&
      dismissedGoalSuggestionInput !== input
    ) {
      setDismissedGoalSuggestionInput(null);
    }
  }, [input, dismissedGoalSuggestionInput]);
  const goalSuggestionDraft = getGoalSuggestionDraft(input);
  const showGoalSuggestion =
    !showAgentApprovalPrompt &&
    !isWaitingForReply &&
    chatMode === "agent" &&
    subscription !== "free" &&
    goalEnabled &&
    !goalMode &&
    dismissedGoalSuggestionInput !== input &&
    goalSuggestionDraft !== null;
  const goalExposure = useRef(false);
  useEffect(() => {
    if (showGoalSuggestion && !goalExposure.current) {
      goalExposure.current = true;
      captureAuthenticatedEvent("agent_goal_exposed", {
        surface: "goal_slash_command",
        composer_layout:
          isMobile === undefined ? "unknown" : isMobile ? "mobile" : "desktop",
        goal_ui_version: 2,
      });
    }
  }, [showGoalSuggestion, isMobile]);
  const captureGoalComposerAction = (
    action:
      | "submit_attempt"
      | "submit_accepted"
      | "submit_refused"
      | "submit_error"
      | "submit_unconfirmed"
      | "submit_canceled"
      | "blocked"
      | "exit",
    reason?:
      | "close_button"
      | "escape"
      | "offline"
      | "send_disabled"
      | "empty"
      | "uploading"
      | "not_ready"
      | "saved_message"
      | "start_response_lost"
      | "lookup_unavailable",
  ) => {
    captureAuthenticatedEvent("agent_goal_composer_action", {
      goal_ui_version: 2,
      composer_layout:
        isMobile === undefined ? "unknown" : isMobile ? "mobile" : "desktop",
      action,
      ...(reason ? { reason } : {}),
      has_draft: !!input.trim(),
      has_attachments: uploadedFiles.length > 0,
      is_new_chat: draftId === "new",
      ...(chatId ? { chat_id: chatId } : {}),
    });
  };
  const reportUnconfirmedGoalSubmission = (
    error: GoalSubmissionUnconfirmedError,
  ) => {
    captureGoalComposerAction(
      "submit_unconfirmed",
      error.messagePersisted === true
        ? "saved_message"
        : error.messagePersisted === false
          ? "start_response_lost"
          : "lookup_unavailable",
    );
    // The linked originating chat makes this safe after navigation or
    // unmount; a missing handle must never silently invite a duplicate.
    toast.info(`${error.message} Your draft is kept.`, {
      action: {
        label: "Check chat",
        onClick: () =>
          error.chatId
            ? window.location.assign(`/c/${encodeURIComponent(error.chatId)}`)
            : window.location.reload(),
      },
    });
  };
  const exitGoalMode = (reason: "close_button" | "escape") => {
    if (goalMode) captureGoalComposerAction("exit", reason);
    setGoalMode(false);
  };
  const selectGoal = () => {
    if (goalSuggestionDraft === null) return;
    captureAuthenticatedEvent("agent_goal_selected", {
      surface: "goal_slash_command",
      composer_layout:
        isMobile === undefined ? "unknown" : isMobile ? "mobile" : "desktop",
      goal_ui_version: 2,
    });
    setGoalMode(true);
    setInput(goalSuggestionDraft);
  };
  const predictionPreference = useQuery(
    api.userCustomization.getPredictionPreference,
    user ? {} : "skip",
  );
  const nextActions = useNextActions({
    userId: user?.id,
    chatId,
    chatMode,
    modeReady: predictionModeReady,
    completedTurn: completedPredictionTurn,
    interruptedTurn: interruptedPredictionTurn,
    latestMessageId,
    latestMessageIsAssistant,
    status,
    input,
    getInput,
    setInput,
    hasAttachments: () =>
      getUploadedFiles().length > 0 ||
      getDraftAttachmentsById(draftId).length > 0,
    blocked:
      predictionPreference?.enabled !== true ||
      goalMode ||
      hasActiveGoalRun ||
      pauseGoalOnSend ||
      isMobile !== false ||
      isOffline ||
      !!effectiveSendDisabledReason ||
      isResolvingInitialState ||
      isUploadingFiles ||
      uploadedFiles.length > 0 ||
      !!approvalRequest ||
      isWaitingForReply ||
      !!editingQueuedMessageId ||
      messageQueue.length > 0,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    if (questionKey) {
      // A persisted "submitting" wait is a reply claim, not an in-flight HTTP
      // request. Identical retries recover delivery; the server fences changes.
      if (
        !questionAnswers.ready ||
        !questionAnswers.canAdvance ||
        isOffline ||
        effectiveSendDisabledReason ||
        uploadedFiles.length ||
        submissionPending ||
        isStoppingAgent
      )
        return;
      if (questionAnswers.index < answerQuestions.length - 1) {
        questionAnswers.go(questionAnswers.index + 1);
        return;
      }
      if (!questionAnswers.text) {
        toast.error("Could not send your answers", {
          id: `question-answer-limit:${questionKey}`,
          description:
            "Answer every question and shorten long answers so the combined reply fits within 20,000 characters. Your choices are saved.",
        });
        return;
      }
      isSubmittingRef.current = true;
      setSubmissionPending(true);
      try {
        questionAnswers.markSubmitted();
        const accepted = await onSubmit(e, questionAnswers.text, true);
        if (accepted !== false) questionAnswers.clear();
      } catch (error) {
        if (error instanceof AgentReplyConflictError) {
          questionAnswers.releaseSubmission();
        } else if (error instanceof GoalSubmissionUnconfirmedError) {
          reportUnconfirmedGoalSubmission(error);
        } else if (!(error instanceof Error && error.name === "AbortError")) {
          toast.error(
            "Could not send your answer. Your choices are saved; try again.",
          );
        }
      } finally {
        isSubmittingRef.current = false;
        if (isMountedRef.current) setSubmissionPending(false);
      }
      return;
    }
    const isGoalSubmission = goalMode && !isWaitingForReply;
    if (showGoalSuggestion) {
      selectGoal();
      return;
    }
    if (
      isOffline ||
      effectiveSendDisabledReason ||
      (isGoalSubmission && !input.trim())
    ) {
      if (isGoalSubmission)
        captureGoalComposerAction(
          "blocked",
          isOffline ? "offline" : !input.trim() ? "empty" : "send_disabled",
        );
      return;
    }

    const canSubmit =
      (isWaitingForReply ||
        status === "ready" ||
        status === "submitted" ||
        status === "streaming") &&
      !isUploadingFiles &&
      (input.trim() || uploadedFiles.length > 0);

    if (canSubmit) {
      if (isGoalSubmission) captureGoalComposerAction("submit_attempt");

      isSubmittingRef.current = true;
      const finishPredictionSubmission = nextActions.prepareSubmission();
      setSubmissionPending(true);
      const submittedInput = getInput();
      const submittedFiles = getUploadedFiles();
      const submittedDraftAttachments = JSON.stringify(
        getDraftAttachmentsById(draftId),
      );
      try {
        isSubmittingAttachmentsRef.current =
          clearDraftOnSubmit && uploadedFiles.length > 0;
        const accepted = await onSubmit(
          e,
          isGoalSubmission ? `/goal start ${input}` : undefined,
        );
        if (isGoalSubmission)
          captureGoalComposerAction(
            accepted === false ? "submit_refused" : "submit_accepted",
          );
        finishPredictionSubmission(accepted !== false);
        if (accepted !== false && isGoalSubmission) setGoalMode(false);
        const unchanged =
          getInput() === submittedInput &&
          (getUploadedFiles() === submittedFiles ||
            (getUploadedFiles().length === 0 && submittedFiles.length === 0));
        // The chat handler can already have cleared the accepted submission.
        const alreadyCleared =
          getInput() === "" && getUploadedFiles().length === 0;
        const sameDraft =
          prevDraftIdRef.current === draftId ||
          (draftId === "new" && prevDraftIdRef.current === chatId);
        if (
          accepted !== false &&
          (!sameDraft || !isMountedRef.current) &&
          clearDraftOnSubmit &&
          getDraftContentById(draftId) === submittedInput &&
          JSON.stringify(getDraftAttachmentsById(draftId)) ===
            submittedDraftAttachments
        )
          removeDraft(draftId);
        if (!isMountedRef.current) return;
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
        finishPredictionSubmission(false);
        isSubmittingAttachmentsRef.current = false;
        if (error instanceof GoalSubmissionUnconfirmedError) {
          reportUnconfirmedGoalSubmission(error);
          return;
        }
        if (error instanceof Error && error.name === "AbortError") {
          if (goalMode) captureGoalComposerAction("submit_canceled");
          return;
        }
        if (goalMode) captureGoalComposerAction("submit_error");
        console.error("Failed to submit message:", error);
      } finally {
        isSubmittingRef.current = false;
        if (isMountedRef.current) setSubmissionPending(false);
      }
    } else if (isGoalSubmission) {
      captureGoalComposerAction(
        "blocked",
        isUploadingFiles ? "uploading" : !input.trim() ? "empty" : "not_ready",
      );
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
    return <ChatInputLoadingState topNotice={topNotice} />;
  }

  return (
    <div
      className={`relative flex max-h-[calc(100dvh-4rem)] min-h-0 min-w-0 flex-col px-4 ${isCentered ? "" : "pb-3"}`}
    >
      <div
        ref={chatInputContainerRef}
        className="mx-auto flex min-h-0 w-full min-w-0 max-w-full flex-1 flex-col sm:max-w-[768px]"
        data-testid="chat-input-container"
      >
        {/* Panels keep their content height and scroll as a stack instead of
            shrinking beneath the next panel. Reserve the input or approval card. */}
        <div
          className={`flex min-h-0 shrink flex-col overflow-y-auto md:bg-background [&>*]:shrink-0 ${showAgentApprovalPrompt ? "max-h-[25dvh]" : "max-h-[calc(100dvh-11rem)]"} ${hasJoinedComposerPanels && !isWaitingForReply && !hasFilePreviews ? "-mb-5 md:mb-0" : ""}`}
        >
          {topNotice}
          {isOffline && (
            <div
              role="status"
              aria-live="polite"
              data-testid="offline-status"
              className="computer-reconnection-warning mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/25 px-3 py-2 text-sm text-foreground sm:flex-row sm:items-center"
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

          {/* Hidden selectors take no space; the bottom-anchored composer stays
              in place while the panels above it use the available height. */}
          {user &&
            isAgent &&
            !showAgentApprovalPrompt &&
            !isWaitingForReply && (
              <div
                className={`relative z-0 mb-1 min-w-0 shrink-0 touch-manipulation items-center justify-end px-2 md:hidden ${sandboxInactive ? "hidden" : "flex"}`}
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
                    className="h-8 rounded-full border bg-background/95 shadow-sm backdrop-blur-md"
                  />
                </div>
              </div>
            )}

          {user && (
            <div
              className={`flex flex-col [&>*+*]:rounded-t-none ${hasJoinedComposerPanels && !isWaitingForReply ? "[&>*:last-child]:pb-[19px] md:[&>*:last-child]:pb-0" : ""} ${hasJoinedComposerPanels && !isWaitingForReply && hasFilePreviews ? "-mb-5 md:mb-0" : ""}`}
            >
              <TodoPanel status={status} />

              {messageQueue.length > 0 && !isWaitingForReply && (
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

              {isWaitingForReply && !hasQuestionPanel && (
                <WaitingForReplyBanner
                  submitting={pendingUserWait?.status === "submitting"}
                  stopping={isStoppingAgent}
                  hasAttachments={uploadedFiles.length > 0}
                  hideStop={hideStop || !pendingUserWait}
                  onStop={() => void handleAgentStop()}
                />
              )}
            </div>
          )}

          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {isWaitingForReply
              ? pendingUserWait?.status === "submitting"
                ? "Sending your reply"
                : "Agent paused. Waiting for your reply"
              : ""}
          </span>

          {!showAgentApprovalPrompt &&
            uploadedFiles &&
            uploadedFiles.length > 0 && (
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

        {showGoalSuggestion && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={selectGoal}
            className="order-1 mb-2 flex min-h-10 w-full min-w-0 items-center gap-3 rounded-2xl border bg-muted px-3 py-1.5 text-left hover:bg-accent"
          >
            <GoalTargetIcon className="size-4 shrink-0" />
            <span className="shrink-0">Goal</span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              Set a goal to keep pursuing
            </span>
          </button>
        )}
        <div
          className={`min-w-0 shrink-0 ${goalPlacement === "detached" ? "order-first" : "order-1"}`}
          data-testid="chat-input-goal-slot"
        >
          {goalPanel?.(goalPlacement)}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={handleFileUploadEvent}
        />

        {showAgentApprovalPrompt && (
          <AgentApprovalPrompt
            request={approvalRequest}
            hasConnectionError={status === "error"}
            onRetryConnection={onReconnect}
            onStop={() => void handleAgentStop()}
          />
        )}
        <div
          hidden={showAgentApprovalPrompt}
          className="order-2 flex min-h-0 flex-col"
        >
          {user && hasQuestionPanel && questionAnswers.question && (
            <UserInputQuestionPanel
              key={`${questionKey}:${questionAnswers.question.id}`}
              question={questionAnswers.question}
              answer={questionAnswers.answer}
              index={questionAnswers.index}
              total={questions.length}
              disabled={
                !questionAnswers.ready ||
                submissionPending ||
                isStoppingAgent ||
                isOffline ||
                !!effectiveSendDisabledReason
              }
              answersLocked={questionAnswers.locked}
              stopping={isStoppingAgent}
              onSelect={questionAnswers.select}
              onStop={
                pendingUserWait && !hideStop
                  ? () => void handleAgentStop()
                  : undefined
              }
            />
          )}
          <div
            className={`chat-input-glass-surface relative z-10 order-2 flex shrink-0 max-h-[min(300px,50dvh)] min-h-[96px] min-w-0 touch-manipulation flex-col gap-3 overflow-hidden border border-black/8 py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] transition-colors dark:border-border ${hasQuestionPanel ? "rounded-b-[22px]" : uploadedFiles && uploadedFiles.length > 0 ? "rounded-b-[22px] border-t-0" : "rounded-[22px]"}`}
            data-testid="chat-input-surface"
            data-panels-joined={hasJoinedComposerPanels || undefined}
            onPointerDownCapture={holdComposerFocusForPointer}
            onClick={(event) => {
              // Reveal controls only after focus, not during touch start. Focus
              // padding taps inside the click gesture so mobile opens the keyboard.
              const target = event.target;
              if (
                !(target instanceof Element) ||
                !event.currentTarget.contains(target) ||
                target.closest(
                  "button, a, input, textarea, select, label, [contenteditable], [role='button'], [role='menuitem'], [role='option'], [role='combobox']",
                )
              )
                return;
              const textarea = composerTextareaRef.current;
              if (textarea && textarea !== document.activeElement) {
                textarea.focus({ preventScroll: true });
              }
            }}
          >
            <ChatInputTextarea
              answerInput={
                questionKey
                  ? {
                      value: questionAnswers.answer.customAnswer,
                      onChange: questionAnswers.setCustomAnswer,
                    }
                  : undefined
              }
              disabled={
                !!questionKey &&
                (!questionAnswers.ready ||
                  questionAnswers.locked ||
                  questionAnswers.question?.allowCustomAnswer === false ||
                  submissionPending)
              }
              prediction={nextActions.batch?.suggestions[0]}
              onAcceptPrediction={() => nextActions.accept(0, "keyboard")}
              onPredictionExposed={nextActions.exposed}
              onPredictionTyping={nextActions.recordTyping}
              onDismissPrediction={nextActions.dismiss}
              composerRef={composerTextareaRef}
              draftId={draftId}
              chatMode={chatMode}
              onEnterSubmit={handleSubmit}
              minRows={isCentered ? 3 : 1}
              placeholder={
                hasQuestionPanel
                  ? questionAnswers.question?.allowCustomAnswer === false
                    ? "Choose an option above"
                    : questionAnswers.question?.options.length
                      ? "Choose an option or type your answer…"
                      : "Type your answer…"
                  : isWaitingForReply
                    ? "Type your answer…"
                    : goalMode
                      ? "Describe your goal, define measurable outcomes for best results"
                      : placeholder
              }
              describedBy={
                isWaitingForReply && !hasQuestionPanel
                  ? WAITING_FOR_REPLY_DESCRIPTION_ID
                  : undefined
              }
              isReplyingToAgent={isWaitingForReply}
              onCommandKeyDown={(e) => {
                if (showGoalSuggestion && e.key === "Tab") {
                  e.preventDefault();
                  selectGoal();
                }
                if (e.key === "Escape") {
                  // Dismiss composer UI before the global Stop shortcut.
                  if (goalMode || showGoalSuggestion) e.preventDefault();
                  exitGoalMode("escape");
                  setDismissedGoalSuggestionInput(input);
                }
              }}
              autoFocus={autoFocus}
              onFocus={() => setComposerFocused(true)}
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
              replyActionLabel={
                isWaitingForReply
                  ? questionAnswers.index < answerQuestions.length - 1
                    ? "Next"
                    : answerQuestions.length > 1
                      ? "Submit answers"
                      : "Submit answer"
                  : undefined
              }
              replyBack={
                isWaitingForReply && questionAnswers.index > 0
                  ? {
                      onClick: () =>
                        questionAnswers.go(questionAnswers.index - 1),
                      disabled: submissionPending || isStoppingAgent,
                    }
                  : undefined
              }
              goalMenu={
                !isWaitingForReply &&
                isMobile !== undefined &&
                user &&
                chatMode === "agent" &&
                subscription !== "free" &&
                goalEnabled
                  ? {
                      active: goalMode,
                      layout: isMobile === true ? "mobile" : "desktop",
                      hasDraft: !!input.trim(),
                      hasAttachments: uploadedFiles.length > 0,
                      onSelect: () => {
                        setGoalMode(true);
                      },
                      onFocusComposer: () =>
                        composerTextareaRef.current?.focus({
                          preventScroll: true,
                        }),
                    }
                  : undefined
              }
              goalControl={
                goalMode && !isWaitingForReply ? (
                  <GoalModeButton
                    compact={isMobile === true}
                    onClear={() => exitGoalMode("close_button")}
                  />
                ) : undefined
              }
              allowSendWhileGenerating={hasActiveGoalRun}
              pausesGoal={
                pauseGoalOnSend &&
                !isWaitingForReply &&
                !goalMode &&
                !/^\/goal(?:\s|$)/i.test(input.trim())
              }
              onAttachClick={handleAttachClick}
              isGenerating={isGenerating && !isWaitingForReply}
              isReplyingToAgent={isWaitingForReply}
              attachmentsDisabled={isWaitingForReply}
              hideStop={hideStop || (isWaitingForReply && !pendingUserWait)}
              onStop={() => void handleAgentStop()}
              onSubmit={handleSubmit}
              status={status}
              isUploadingFiles={isUploadingFiles}
              input={
                questionKey
                  ? questionAnswers.canAdvance
                    ? "answer"
                    : ""
                  : input
              }
              uploadedFiles={uploadedFiles}
              chatMode={user ? chatMode : "ask"}
              isOnline={!isOffline}
              sendDisabledReason={
                questionKey && (submissionPending || isStoppingAgent)
                  ? isStoppingAgent
                    ? "Stopping…"
                    : "Sending your answer…"
                  : goalMode && !isWaitingForReply && !input.trim()
                    ? "Describe your goal before sending."
                    : effectiveSendDisabledReason
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
};
