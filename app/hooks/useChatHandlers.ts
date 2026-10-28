import { parseGoalCommand, goalResumeMessage } from "@/lib/goals/commands";
import { useRef, RefObject, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "../contexts/GlobalState";
import { useCommittedRef, useLatestRef } from "@/app/hooks/useLatestRef";
import { cancelDesktopRunLocally } from "@/app/services/desktop-command-cancellation";
import { cancelAgentRunWithRetry } from "@/app/services/agent-run-cancellation";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import { shouldUseAgentLongForAgent } from "@/lib/chat/agent-routing";
import { AGENT_RESUME_ENDPOINT } from "@/lib/api/agent-endpoints";
import { getPendingAgentLongRunStart } from "@/lib/chat/agent-long-transport";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import {
  normalizeSelectedModelForSubscription,
  type ChatMessage,
  type ChatStatus,
  type LimitRescueRequest,
  type SelectedModel,
} from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import {
  getMaxFileTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-limits";
import { getInputTokenLimitStatus } from "@/lib/utils/client-token-validation";
import { toast } from "sonner";
import { removeTodosBySourceMessages } from "@/lib/utils/todo-utils";
import { useDataStreamDispatch } from "@/app/components/DataStreamProvider";
import { getOnlineStatusSnapshot } from "@/app/hooks/useOnlineStatus";
import { AUTO_CONTINUE_PROMPT } from "@/app/hooks/useAutoContinue";
import { normalizeMessages } from "@/lib/utils/message-processor";
import {
  getAutoContinueChainAssistantIds,
  getMessagesUpToLastRealUser,
  findLastUserMessageIndex,
} from "@/lib/utils/message-utils";
import {
  createFileMessagePartFromUploadedFile,
  getMaxFilesLimitForMode,
} from "@/lib/utils/file-utils";
import { hasRestageableLocalDesktopAttachments } from "@/lib/utils/local-attachment-messages";
import { isPastedTextAttachmentAvailableInMode } from "@/lib/utils/pasted-text-attachments";
import { sanitizeForConvexValue } from "@/lib/db/convex-value-sanitizer";
import { reconcileSidebarContentAfterRegeneration } from "@/lib/utils/sidebar-utils";
import { v4 as uuidv4 } from "uuid";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  prepareAgentCancellationTelemetry,
  type AgentCancellationAction,
} from "@/lib/analytics/agent-cancellation";

interface UseChatHandlersProps {
  goalState?: string;
  goalGeneration?: number;
  persistedTriggerRunId?: string;
  sendDisabledReason?: string;
  chatId: string;
  messages: ChatMessage[];
  sendMessage: (
    message?: any,
    options?: { body?: any },
  ) => void | Promise<void>;
  sendQueuedMessage?: (
    id: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
  stop: () => void;
  regenerate: (options?: { body?: any }) => void | Promise<void>;
  setMessages: (
    messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
  isExistingChat: boolean;
  isUserMessagePersisted?: (messageId: string) => boolean | Promise<boolean>;
  status: ChatStatus;
  isSummarizing?: boolean;
  isSendingNowRef: RefObject<boolean>;
  hasManuallyStoppedRef: RefObject<boolean>;
  activeTriggerRunRef?: RefObject<string | undefined>;
  resumeActiveRun?: () => void | Promise<void>;
  prepareAgentRecovery?: () => Promise<boolean | void>;
  getAgentRunRequestGeneration?: () => number;
  onAgentRunAlreadyFinished?: (
    runId: string | undefined,
    requestGeneration: number | undefined,
  ) => void;
  onStopCallback?: () => void;
  resetAutoContinueCount?: () => void;
}

export type RetryOptions = {
  limitRescue?: LimitRescueRequest;
  /** Override the model for this retry, e.g. Auto for the daily allowance. */
  selectedModel?: SelectedModel;
};

const getConvexErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object" || !("data" in error)) {
    return undefined;
  }

  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) {
    return undefined;
  }

  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

export const useChatHandlers = ({
  chatId,
  messages,
  sendMessage,
  sendQueuedMessage,
  stop,
  regenerate,
  setMessages,
  isExistingChat,
  isUserMessagePersisted,
  status,
  isSummarizing = false,
  isSendingNowRef,
  hasManuallyStoppedRef,
  activeTriggerRunRef,
  resumeActiveRun,
  prepareAgentRecovery,
  getAgentRunRequestGeneration,
  onAgentRunAlreadyFinished,
  onStopCallback,
  resetAutoContinueCount,
  sendDisabledReason,
  goalState,
  goalGeneration,
  persistedTriggerRunId,
}: UseChatHandlersProps) => {
  const { setIsAutoResuming } = useDataStreamDispatch();
  const sendDisabledReasonRef = useCommittedRef(sendDisabledReason);
  const {
    getInput,
    getUploadedFiles,
    chatMode,
    clearInput,
    clearUploadedFiles,
    todos,
    setTodos,
    subscription,
    queueMessage,
    messageQueue,
    removeQueuedMessage,
    queueBehavior,
    editingQueuedMessageId,
    sandboxPreference,
    desktopEnvironmentId,
    agentPermissionMode,
    selectedModel,
    sidebarOpen,
    sidebarContent,
    openSidebar,
    closeSidebar,
  } = useGlobalState();
  const requestSelectedModel = normalizeSelectedModelForSubscription(
    selectedModel,
    subscription,
  );
  // MessageItem intentionally ignores callback identity in its memo comparator,
  // so a rendered Regenerate button can retain an older handler closure.
  const requestSelectedModelRef = useLatestRef(requestSelectedModel);

  // Avoid stale closure on chatMode: on mobile, a tap on Regenerate can fire
  // before React commits the new chatMode after a mode toggle, sending the
  // previous mode in the request body. Reading from a ref always gets the
  // latest value at the moment of the click.
  const chatModeRef = useLatestRef(chatMode);
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const desktopEnvironmentIdRef = useLatestRef(desktopEnvironmentId);
  const agentPermissionModeRef = useLatestRef(agentPermissionMode);
  const subscriptionRef = useLatestRef(subscription);
  const recoveryPendingRef = useRef(false);
  const retryPendingRef = useRef(false);
  const currentChatIdRef = useLatestRef(chatId);
  const todosRef = useLatestRef(todos);
  const statusRef = useLatestRef(status);
  const isSummarizingRef = useCommittedRef(isSummarizing);
  const stopGenerationRef = useRef(0);
  const [sendNowReleaseVersion, setSendNowReleaseVersion] = useState(0);
  const sidebarOpenRef = useLatestRef(sidebarOpen);
  const sidebarContentRef = useLatestRef(sidebarContent);
  const [summarySteer, setSummarySteer] = useState<{
    chatId: string;
    messageId: string;
    options?: RetryOptions;
  } | null>(null);

  useEffect(() => {
    setSummarySteer(null);
    return () => {
      stopGenerationRef.current += 1;
    };
  }, [chatId]);

  const isSendableUploadedFile = (
    file: ReturnType<typeof getUploadedFiles>[number],
  ) =>
    file.uploaded &&
    !file.uploading &&
    !file.error &&
    (file.storage === "local-desktop"
      ? !!file.localAttachmentId && !!file.localPath
      : !!file.fileId);

  const runChatAction = async (
    description: string,
    action: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(`Failed to ${description}:`, error);
    }
  };

  const deleteLastAssistantMessage = useMutation(
    api.messages.deleteLastAssistantMessage,
  );
  const saveAssistantMessage = useMutation(api.messages.saveAssistantMessage);
  const regenerateWithNewContent = useMutation(
    api.messages.regenerateWithNewContent,
  );
  const cancelStreamMutation = useMutation(
    api.chatStreams.cancelStreamFromClient,
  );
  const getConvexSafeParts = (parts: ChatMessage["parts"]) =>
    sanitizeForConvexValue(parts) as ChatMessage["parts"];

  // A persisted active run takes precedence over the current UI mode. This
  // matters while restoring an approval before mode initialization completes.
  const shouldCancelTriggerRun = () =>
    Boolean(activeTriggerRunRef?.current) ||
    shouldUseAgentLongForAgent({
      mode: chatModeRef.current,
      subscription: subscriptionRef.current,
      isTauri: isTauriEnvironment(),
    });

  type AgentCancellationResult =
    | { outcome: "not_applicable" | "canceled" }
    | {
        outcome: "stale_run";
        expectedTriggerRunId?: string;
        activeTriggerRunId?: string | null;
      };

  const cancelTriggerRun = async (
    action: AgentCancellationAction,
    beforeCancel?: Promise<unknown>,
  ): Promise<AgentCancellationResult> => {
    const startTelemetry = prepareAgentCancellationTelemetry(chatId, action);
    const pendingStart = getPendingAgentLongRunStart(chatId);
    if (!pendingStart && !shouldCancelTriggerRun()) {
      await beforeCancel;
      return { outcome: "not_applicable" };
    }
    // Capture the target before awaiting: a later run or navigation must not
    // change which task this Stop is allowed to cancel.
    const currentRunId = activeTriggerRunRef?.current;
    const stopLocalRun = (runId: string) => {
      void cancelDesktopRunLocally(chatId, runId).catch((error) => {
        console.error("Failed to stop local commands:", error);
        toast.error("Could not stop the local command. Please try Stop again.");
      });
    };
    // Do not wait for an HTTP request or stream teardown before local IPC.
    // A pending start owns a different run; never cancel the previous one.
    if (!pendingStart && currentRunId) stopLocalRun(currentRunId);
    let startFailure: unknown;
    const [startedRun] = await Promise.all([
      pendingStart?.then(
        (run) => {
          const runId = run?.runId ?? currentRunId;
          if (runId) stopLocalRun(runId);
          return run;
        },
        (error: unknown) => {
          startFailure = error;
          if (currentRunId) stopLocalRun(currentRunId);
          return undefined;
        },
      ),
      beforeCancel,
    ]);
    const expectedTriggerRunId = startedRun?.runId ?? currentRunId;
    // Cancel a captured existing run even if the new start failed. Without an
    // exact handle, never send a broad cancellation that could hit a later run.
    if (!expectedTriggerRunId) {
      if (startFailure) throw startFailure;
      return { outcome: "not_applicable" };
    }
    const settleTelemetry = startTelemetry(expectedTriggerRunId);
    let retryToast: string | number | undefined;
    const result = await cancelAgentRunWithRetry(
      chatId,
      expectedTriggerRunId,
      () => {
        retryToast = toast.info("Stop is waiting for a connection", {
          description:
            "Your cancellation will retry automatically. Keep the app open.",
          duration: Infinity,
        });
      },
    )
      .then(
        (result) => {
          settleTelemetry(
            result.outcome === "canceled" ? "accepted" : result.outcome,
          );
          return result;
        },
        (error: unknown) => {
          settleTelemetry("error");
          throw error;
        },
      )
      .finally(() => {
        if (retryToast !== undefined) toast.dismiss(retryToast);
      });
    if (result.outcome === "stale_run") return result;
    // A lost start response can still hide a newly created durable task. Keep
    // that uncertainty visible and prevent steering from starting another run.
    if (startFailure) throw startFailure;
    return { outcome: "canceled" };
  };

  const recoverStaleAgentRun = async (
    result: Extract<AgentCancellationResult, { outcome: "stale_run" }>,
    requestGeneration?: number,
  ): Promise<void> => {
    hasManuallyStoppedRef.current = false;
    if (activeTriggerRunRef && result.activeTriggerRunId !== undefined) {
      activeTriggerRunRef.current = result.activeTriggerRunId ?? undefined;
    }

    const hasNoActiveRun = result.activeTriggerRunId === null;

    captureAuthenticatedEvent("agent_cancel_stale_recovery_started", {
      chat_id: chatId,
      expected_trigger_run_id: result.expectedTriggerRunId,
      active_trigger_run_id: result.activeTriggerRunId,
      recovery_action: hasNoActiveRun
        ? "no_active_run"
        : resumeActiveRun
          ? "resume_stream"
          : "persisted_state",
      cancellation_applied: false,
    });

    if (hasNoActiveRun) {
      setIsAutoResuming(false);
      // The user's intent is already satisfied. Treat this completion race as
      // a silent, successful reconciliation instead of surfacing internal run
      // lifecycle state or asking them to repeat an action that cannot help.
      onAgentRunAlreadyFinished?.(
        result.expectedTriggerRunId,
        requestGeneration,
      );
      return;
    }

    toast.info("Agent run changed", {
      description: "Reconnecting to the current run instead of cancelling it.",
    });

    if (!resumeActiveRun) {
      setIsAutoResuming(false);
      return;
    }

    setIsAutoResuming(true);
    try {
      await resumeActiveRun();
    } catch (error) {
      setIsAutoResuming(false);
      console.error("Failed to resume the current Agent run:", error);
      toast.error("Could not reconnect to the current Agent run.");
    }
  };

  /**
   * Helper to stop an active stream, normalize messages, and persist state.
   * Returns the normalized messages array.
   * Should be called before any message management operation during streaming.
   */
  const stopActiveStream = async (options?: {
    skipSave?: boolean;
    requireCancelSuccess?: boolean;
    requireSaveSuccess?: boolean;
  }): Promise<ChatMessage[]> => {
    // Stop the stream immediately (client-side abort)
    stop();

    // Early return if no messages to process
    if (messages.length === 0) return messages;

    // Normalize messages to mark incomplete tools as interrupted/completed
    const { messages: normalizedMessages, hasChanges } = normalizeMessages(
      messages,
      { userInitiatedAbort: true },
    );

    const stopTime = Date.now();
    const normalizedLastMessage =
      normalizedMessages[normalizedMessages.length - 1];
    const generationStartedAt =
      typeof normalizedLastMessage?.metadata?.generationStartedAt === "number"
        ? normalizedLastMessage.metadata.generationStartedAt
        : undefined;
    const generationTimeMs =
      generationStartedAt !== undefined
        ? Math.max(0, stopTime - generationStartedAt)
        : undefined;
    const stoppedMessages =
      normalizedLastMessage?.role === "assistant" &&
      generationTimeMs !== undefined
        ? [
            ...normalizedMessages.slice(0, -1),
            {
              ...normalizedLastMessage,
              metadata: {
                ...normalizedLastMessage.metadata,
                mode:
                  normalizedLastMessage.metadata?.mode ?? chatModeRef.current,
                generationStartedAt,
                generationTimeMs,
              },
            },
          ]
        : normalizedMessages;

    // Update local state if changes were made
    if (hasChanges || stoppedMessages !== normalizedMessages) {
      setMessages(stoppedMessages);
    }

    // Run cancel and save in parallel - they're independent operations
    const lastMessage = stoppedMessages[stoppedMessages.length - 1];
    const savePromise =
      !options?.skipSave && lastMessage?.role === "assistant"
        ? saveAssistantMessage({
            id: lastMessage.id,
            chatId,
            role: lastMessage.role,
            parts: getConvexSafeParts(lastMessage.parts),
            mode: lastMessage.metadata?.mode ?? chatModeRef.current,
            generationStartedAt,
            generationTimeMs,
          }).catch((error) => {
            console.error("Failed to save message on stop:", error);
            if (options?.requireSaveSuccess) throw error;
          })
        : Promise.resolve();

    const cancelPromise = cancelStreamMutation({
      chatId,
      skipSave: options?.skipSave || undefined,
      todos,
    });
    await Promise.all([
      options?.requireCancelSuccess
        ? cancelPromise
        : cancelPromise.catch((error) => {
            console.error("Failed to cancel stream:", error);
          }),
      savePromise,
    ]);

    return normalizedMessages;
  };

  const stopActiveRunForReplacement = async (
    action: "regenerate" | "retry" | "edit",
  ): Promise<boolean> => {
    const requestGeneration = getAgentRunRequestGeneration?.();
    const [triggerCancelResult, streamStopResult] = await Promise.allSettled([
      cancelTriggerRun(action),
      stopActiveStream({ skipSave: true }),
    ]);

    if (triggerCancelResult.status === "rejected") {
      console.error(
        "Failed to cancel trigger.dev run before replacement:",
        triggerCancelResult.reason,
      );
      toast.error("Could not restart the Agent run. Please try again.");
      throw triggerCancelResult.reason;
    }
    if (streamStopResult.status === "rejected") {
      throw streamStopResult.reason;
    }
    if (triggerCancelResult.value.outcome === "stale_run") {
      await recoverStaleAgentRun(triggerCancelResult.value, requestGeneration);
      return false;
    }
    return true;
  };

  const stopActiveRunForSteer = async (
    action: "stop_and_send" | "send_now",
  ): Promise<boolean> => {
    const requestGeneration = getAgentRunRequestGeneration?.();
    // Persist the latest message and todo snapshot before canceling the Trigger
    // run. The next run reads the persisted todo snapshot.
    // Capture a pending start now, before the todo save can outlive its response.
    const cancelResult = await cancelTriggerRun(
      action,
      stopActiveStream({ requireCancelSuccess: true }),
    );
    if (cancelResult.outcome === "stale_run") {
      await recoverStaleAgentRun(cancelResult, requestGeneration);
      return false;
    }
    return true;
  };

  const hasActiveRunToReplace = () =>
    status === "streaming" ||
    status === "submitted" ||
    Boolean(activeTriggerRunRef?.current);

  const controlSavedGoal = async (
    action: "pause" | "stop" | "clear",
  ): Promise<{
    state: string;
    stoppedRun: boolean;
    stopGeneration: number;
  }> => {
    let controlGeneration = stopGenerationRef.current;
    const savedResponse = await fetch(
      `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`,
      { cache: "no-store" },
    );
    const saved = await savedResponse.json();
    if (
      !savedResponse.ok ||
      !saved.goal ||
      !Number.isInteger(saved.goal.generation)
    )
      throw new Error(saved.message ?? "No saved goal in this chat.");
    if (
      currentChatIdRef.current !== chatId ||
      stopGenerationRef.current !== controlGeneration
    )
      throw new Error("The task changed. Your draft is saved.");
    if (
      goalGeneration !== undefined &&
      saved.goal.generation !== goalGeneration
    )
      throw new Error("The goal changed. Reload before changing it.");
    const stoppedRun = Boolean(saved.goal.activeRunId);
    if (stoppedRun) {
      if (
        activeTriggerRunRef &&
        persistedTriggerRunId === saved.goal.activeRunId
      )
        activeTriggerRunRef.current = persistedTriggerRunId;
      if (activeTriggerRunRef?.current !== saved.goal.activeRunId)
        throw new Error(
          "The goal run changed. Reload before changing the goal.",
        );
      // Use the same normalization, persistence, and cancellation path as Stop.
      // A later explicit Stop or navigation must still defeat this control.
      const stopping = handleStop({
        requireSavedResponse: true,
        expectedTriggerRunId: saved.goal.activeRunId,
      });
      if (!(await stopping))
        throw new Error(
          "Could not stop and save the current run. Your draft is saved.",
        );
      controlGeneration = stopGenerationRef.current;
    }
    if (
      currentChatIdRef.current !== chatId ||
      stopGenerationRef.current !== controlGeneration
    )
      throw new Error("The task changed. Your draft is saved.");
    const response = await fetch("/api/agent-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        action,
        generation: saved.goal.generation,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "Goal control failed");
    if (
      currentChatIdRef.current !== chatId ||
      stopGenerationRef.current !== controlGeneration
    )
      throw new Error("The task changed. Your draft is saved.");
    return { state: data.state, stoppedRun, stopGeneration: controlGeneration };
  };

  const handleSubmit = async (
    e: React.FormEvent,
    inputOverride?: string,
    options?: { replaceGoalGeneration?: number },
  ): Promise<boolean> => {
    e.preventDefault();
    if (sendDisabledReasonRef.current) return false;
    let stopGeneration = stopGenerationRef.current;
    let stoppedGoalForMessage = false;
    const wasSummarizing = isSummarizingRef.current;

    // Read the prompt only when the user submits. Keeping the live composer
    // value out of this hook prevents each keystroke from rerendering Chat.
    const submittedInput = getInput();
    const uploadedFiles = getUploadedFiles();
    const input = inputOverride ?? submittedInput;
    let goalCommand;
    let resumeMessage: string | undefined;
    let goalSettings: Record<string, unknown> = {};
    try {
      goalCommand = parseGoalCommand(input);
      if (
        goalCommand?.action === "start" &&
        options?.replaceGoalGeneration !== undefined
      ) {
        if (options.replaceGoalGeneration !== goalGeneration) {
          toast.error(
            "The goal changed. Keep your draft and reopen the current goal before sending an edit.",
          );
          return false;
        }
        goalCommand.expectedGeneration = options.replaceGoalGeneration;
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Invalid goal command",
      );
      return false;
    }
    if (goalCommand) {
      if (["status", "pause", "stop", "clear"].includes(goalCommand.action)) {
        // New chats have no persisted owner record to reconcile yet.
        if (!isExistingChat) {
          toast.info(
            "No goal in this chat. Use /goal followed by an objective.",
          );
          clearInput();
          return true;
        }
        try {
          const data =
            goalCommand.action === "status"
              ? await (async () => {
                  const response = await fetch(
                    `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`,
                    { cache: "no-store" },
                  );
                  const result = await response.json();
                  if (!response.ok)
                    throw new Error(result.message ?? "Goal control failed");
                  return result;
                })()
              : await controlSavedGoal(
                  goalCommand.action as "pause" | "stop" | "clear",
                );
          toast.info(
            data.goal
              ? `Goal: ${data.goal.state.replaceAll("_", " ")}`
              : data.state
                ? `Goal ${data.state}`
                : "No goal in this chat. Use /goal followed by an objective.",
          );
          if (getInput() === submittedInput) clearInput();
          return true;
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Goal control failed",
          );
          return false;
        }
      }
      if (chatModeRef.current !== "agent" || subscription === "free") {
        toast.error("Use Agent mode on a paid plan to start or resume a goal.");
        return false;
      }
      if (
        status !== "ready" ||
        activeTriggerRunRef?.current ||
        messageQueue.length
      ) {
        toast.info(
          "Wait for this chat’s current work and queued messages to settle before starting or resuming a goal.",
        );
        return false;
      }
      if (goalCommand.action === "resume") {
        try {
          const r = await fetch(
            `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`,
            { cache: "no-store" },
          );
          const data = await r.json();
          if (!r.ok || !data.goal)
            throw new Error(data.message ?? "No saved goal in this chat.");
          resumeMessage = goalResumeMessage(data.goal, goalCommand.input);
          goalSettings = {
            sandboxPreference: data.goal.sandboxPreference,
            agentPermissionMode: data.goal.permissionMode,
            selectedModel: data.goal.selectedModel,
          };
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Goal could not resume",
          );
          return false;
        }
      }
    }
    const clearSubmittedDraft = () => {
      if (
        getInput() === submittedInput &&
        getUploadedFiles() === uploadedFiles
      ) {
        clearInput();
        clearUploadedFiles();
      }
    };

    // The visible composer normally blocks this path while offline. Check the
    // browser snapshot again here so a connectivity race cannot clear a draft.
    if (!getOnlineStatusSnapshot()) {
      toast.info("You're offline", {
        description: "Your draft is saved. Reconnect before sending.",
      });
      return false;
    }

    setIsAutoResuming(false);

    // Reset manual stop flag when user submits a new message
    hasManuallyStoppedRef.current = false;
    resetAutoContinueCount?.();

    // Prevent submission if files are still uploading
    if (uploadedFiles.some((file) => file.uploading || file.error)) {
      return false;
    }
    const currentChatMode = chatModeRef.current;
    const hasUnavailableLocalFiles = uploadedFiles.some(
      (file) =>
        file.storage === "local-desktop" &&
        (file.unavailable || !file.localAttachmentId || !file.localPath),
    );
    if (hasUnavailableLocalFiles) {
      toast.error("Local attachment is unavailable", {
        description:
          "Open this draft on the Desktop device where the file was created, or remove the attachment before sending.",
      });
      return false;
    }
    const hasUnavailablePastedText = uploadedFiles.some(
      (file) => !isPastedTextAttachmentAvailableInMode(file, currentChatMode),
    );
    if (hasUnavailablePastedText) {
      toast.error("Pasted text is unavailable in Ask", {
        description:
          "Switch to Agent mode, show it in the text field, or remove the attachment.",
      });
      return false;
    }
    // Allow submission if there's text input or uploaded files
    const hasValidFiles = uploadedFiles.some(isSendableUploadedFile);
    if (!input.trim() && !hasValidFiles) {
      return false;
    }
    const maxFilesLimit = getMaxFilesLimitForMode(chatMode);
    if (uploadedFiles.length > maxFilesLimit) {
      toast.error("Cannot send files in this mode", {
        description: `Maximum ${maxFilesLimit} files allowed. Please remove some files or switch modes.`,
      });
      return false;
    }

    const hasLocalDesktopFiles = uploadedFiles.some(
      (file) => file.storage === "local-desktop",
    );
    if (
      hasLocalDesktopFiles &&
      (!isAgentMode(currentChatMode) ||
        !(
          sandboxPreferenceRef.current === "desktop" ||
          (desktopEnvironmentIdRef.current !== undefined &&
            sandboxPreferenceRef.current ===
              `desktop-environment:${desktopEnvironmentIdRef.current}`)
        ))
    ) {
      toast.error("Local attachments require desktop Agent mode", {
        description:
          "Switch back to Agent mode with the desktop sandbox or reattach the file for upload.",
      });
      return false;
    }

    // Check token limit before sending based on user plan
    const maxTokens = getMaxTokensForSubscription(subscription, {
      mode: currentChatMode,
    });

    // Additional validation for Ask mode: ensure files don't exceed Ask mode token limits
    // This prevents uploading files in Agent mode then switching to Ask mode to send them
    if (currentChatMode === "ask" && uploadedFiles.length > 0) {
      const fileTokens = uploadedFiles.reduce(
        (total, file) => total + (file.tokens || 0),
        0,
      );
      const maxFileTokens = getMaxFileTokens(subscription);
      if (fileTokens > maxFileTokens) {
        toast.error("Cannot send files in Ask mode", {
          description: `Files exceed Ask mode token limit (${fileTokens.toLocaleString()}/${maxFileTokens.toLocaleString()} tokens). Tip: Switch to Agent mode or remove large files.`,
        });
        return false;
      }
    }

    const outgoingText =
      goalCommand?.action === "start"
        ? goalCommand.objective
        : (resumeMessage ?? (input.trim() || undefined));
    const tokenLimitStatus = await getInputTokenLimitStatus(
      outgoingText ?? "",
      uploadedFiles,
      maxTokens,
    );
    if (tokenLimitStatus.exceedsLimit) {
      const hasFiles = uploadedFiles.length > 0;
      const planText = subscription !== "free" ? "" : " (Free plan limit)";
      toast.error("Message is too long", {
        description: `Your message is too large (${tokenLimitStatus.tokenCount.toLocaleString()} tokens). Please make it shorter${hasFiles ? " or remove some files" : ""}${planText}.`,
      });
      return false;
    }
    if (
      sendDisabledReasonRef.current ||
      currentChatIdRef.current !== chatId ||
      stopGenerationRef.current !== stopGeneration
    )
      return false;
    if (
      !goalCommand &&
      goalState &&
      ["queued", "running", "waiting", "needs_approval"].includes(goalState)
    ) {
      try {
        const control = await controlSavedGoal("pause");
        stopGeneration = control.stopGeneration;
        stoppedGoalForMessage = control.stoppedRun;
        // This user message deliberately replaces the stopped goal's work.
        if (stoppedGoalForMessage) hasManuallyStoppedRef.current = false;
        toast.info(
          "Goal paused for your message. Resume it from the goal panel when ready.",
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Goal could not pause",
        );
        return false;
      }
    }

    // While an Agent run is starting or streaming, honor the queue behavior.
    if (
      !stoppedGoalForMessage &&
      (status === "streaming" || status === "submitted")
    ) {
      const validFiles = uploadedFiles
        .filter(isSendableUploadedFile)
        .map(createFileMessagePartFromUploadedFile)
        .filter((part): part is NonNullable<typeof part> => part !== null);

      const deferForSummary = wasSummarizing || isSummarizingRef.current;
      if (deferForSummary || queueBehavior === "queue") {
        // During compaction, accept the draft now and steer as soon as the
        // summary settles. Ordinary queue mode waits for the full response.
        const queuedId = queueMessage(input, validFiles);
        if (!queuedId) return false;
        if (deferForSummary) {
          setSummarySteer((current) =>
            current?.chatId === chatId
              ? current
              : { chatId, messageId: queuedId },
          );
        }

        captureAuthenticatedEvent("chat_user_submission", {
          definition_version: 1,
          mode: currentChatMode,
          subscription_tier: subscription,
          queued: true,
        });
        clearSubmittedDraft();

        return true;
      } else if (queueBehavior === "stop-and-send") {
        try {
          if (!(await stopActiveRunForSteer("stop_and_send"))) return false;
        } catch (error) {
          console.error(
            "Failed to stop the active run before steering:",
            error,
          );
          toast.error("Could not steer the Agent run. Please try again.");
          return false;
        }
        // Continue to send the new message immediately below (don't return)
      }
    }
    if (
      sendDisabledReasonRef.current ||
      currentChatIdRef.current !== chatId ||
      stopGenerationRef.current !== stopGeneration
    )
      return false;
    // Admission can fail before a task exists. The transport finalizes the
    // saved-task route after admission; keep rejected submissions on the draft.

    const outgoingMetadata = {
      createdAt: Date.now(),
      ...(goalCommand?.action === "start" ? { goal: { sent: true } } : {}),
    };
    try {
      // Get file objects from uploaded files - URLs are already resolved in global state
      const validFiles = uploadedFiles
        .filter(isSendableUploadedFile)
        .map(createFileMessagePartFromUploadedFile)
        .filter((part): part is NonNullable<typeof part> => part !== null);

      runChatAction("send message", () =>
        sendMessage(
          {
            text: outgoingText,
            files: validFiles.length > 0 ? validFiles : undefined,
            metadata: outgoingMetadata,
          },
          {
            body: {
              mode: currentChatMode,
              todos,
              sandboxPreference,
              agentPermissionMode: agentPermissionModeRef.current,
              selectedModel: requestSelectedModel,
              ...(goalCommand ? { goal: goalCommand } : {}),
              ...goalSettings,
            },
          },
        ),
      );
    } catch (error) {
      console.error("Failed to process files:", error);
      // Fallback to text-only message if file processing fails
      runChatAction("send fallback message", () =>
        sendMessage(
          { text: outgoingText, metadata: outgoingMetadata },
          {
            body: {
              mode: currentChatMode,
              todos,
              sandboxPreference,
              agentPermissionMode: agentPermissionModeRef.current,
              selectedModel: requestSelectedModel,
              ...(goalCommand ? { goal: goalCommand } : {}),
              ...goalSettings,
            },
          },
        ),
      );
    }

    captureAuthenticatedEvent("chat_user_submission", {
      definition_version: 1,
      mode: currentChatMode,
      subscription_tier: subscription,
      queued: false,
    });
    clearSubmittedDraft();
    return true;
  };

  const handleStop = async (options?: {
    requireSavedResponse?: boolean;
    expectedTriggerRunId?: string;
  }) => {
    if (options?.expectedTriggerRunId) {
      const beforeStart = stopGenerationRef.current;
      const pendingStart = getPendingAgentLongRunStart(chatId);
      if (pendingStart) {
        try {
          const started = await pendingStart;
          if (started?.runId !== options.expectedTriggerRunId) return false;
        } catch {
          return false;
        }
      }
      if (
        currentChatIdRef.current !== chatId ||
        stopGenerationRef.current !== beforeStart ||
        activeTriggerRunRef?.current !== options.expectedTriggerRunId
      )
        return false;
    }
    stopGenerationRef.current += 1;
    const stoppedGeneration = stopGenerationRef.current;
    setSummarySteer(null);

    const requestGeneration = getAgentRunRequestGeneration?.();
    captureAuthenticatedEvent("chat_response_stop_requested", {
      chat_id: chatId,
      message_id: messages
        .slice()
        .reverse()
        .find((message) => message.role === "assistant")?.id,
      mode: chatModeRef.current,
      selected_model: requestSelectedModelRef.current ?? "auto",
    });
    setIsAutoResuming(false);

    // Set manual stop flag to prevent auto-processing of queue
    hasManuallyStoppedRef.current = true;

    // Clear any active status indicators immediately
    onStopCallback?.();

    const [triggerCancelResult, streamStopResult] = await Promise.allSettled([
      cancelTriggerRun("stop"),
      stopActiveStream({ requireSaveSuccess: options?.requireSavedResponse }),
    ]);

    if (triggerCancelResult.status === "rejected") {
      console.error(
        "Failed to cancel trigger.dev run:",
        triggerCancelResult.reason,
      );
      toast.error("Could not stop the Agent run. Please try again.");
    }
    if (streamStopResult.status === "rejected") {
      console.error("Error in handleStop:", streamStopResult.reason);
    }

    if (
      triggerCancelResult.status === "fulfilled" &&
      triggerCancelResult.value.outcome === "stale_run"
    ) {
      await recoverStaleAgentRun(triggerCancelResult.value, requestGeneration);
      return false;
    }

    return (
      triggerCancelResult.status === "fulfilled" &&
      streamStopResult.status === "fulfilled" &&
      (!options?.expectedTriggerRunId ||
        (stopGenerationRef.current === stoppedGeneration &&
          currentChatIdRef.current === chatId))
    );
  };

  // Response replacement is an explicit deletion, so reconcile immediately
  // instead of waiting for the sidebar's reconnect grace period.
  const reconcileSidebar = (remainingMessages: ChatMessage[]) => {
    const currentSidebarContent = sidebarContentRef.current;
    if (sidebarOpenRef.current && currentSidebarContent) {
      const nextSidebarContent = reconcileSidebarContentAfterRegeneration(
        remainingMessages,
        currentSidebarContent,
      );

      if (!nextSidebarContent) {
        closeSidebar();
      } else if (nextSidebarContent !== currentSidebarContent) {
        openSidebar(nextSidebarContent);
      }
    }
  };

  const handleRegenerate = async () => {
    if (sendDisabledReasonRef.current) return;
    setIsAutoResuming(false);
    resetAutoContinueCount?.();

    // Stop any active stream first to prevent message order issues and wasted tokens
    if (hasActiveRunToReplace()) {
      if (!(await stopActiveRunForReplacement("regenerate"))) return;
    }
    if (sendDisabledReasonRef.current) return;
    const agentRunRequestId = uuidv4();

    // Remove todos from all assistant messages in the auto-continue chain.
    const chainAssistantIds = getAutoContinueChainAssistantIds(messages);
    captureAuthenticatedEvent("chat_response_regeneration_requested", {
      chat_id: chatId,
      message_id: messages
        .slice()
        .reverse()
        .find((message) => message.role === "assistant")?.id,
      mode: chatModeRef.current,
      selected_model: requestSelectedModelRef.current ?? "auto",
    });
    const cleanedTodos =
      chainAssistantIds.length > 0
        ? removeTodosBySourceMessages(todos, chainAssistantIds)
        : todos;
    if (cleanedTodos !== todos) setTodos(cleanedTodos);

    // Trim client-side message state to the last real user message.
    // Without this, the SDK's regenerate() only removes the last assistant,
    // leaving old auto-continue chain messages visible in the UI.
    const trimmedMessages = getMessagesUpToLastRealUser(messages);

    reconcileSidebar(trimmedMessages);

    setMessages(trimmedMessages);

    const shouldSendClientMessagesForRegenerate =
      hasRestageableLocalDesktopAttachments(trimmedMessages);
    const persistentRegenerateMessages = shouldSendClientMessagesForRegenerate
      ? trimmedMessages
      : [];

    // Delete the trailing response chain and clear summaries that may include
    // that deleted work, so regeneration starts from the original request.
    if (chainAssistantIds.length > 0) {
      await deleteLastAssistantMessage({
        chatId,
        resetSummary: true,
        todos: cleanedTodos,
      });
    }
    if (sendDisabledReasonRef.current) return;
    runChatAction("regenerate response", () =>
      regenerate({
        body: {
          mode: chatModeRef.current,
          messages: persistentRegenerateMessages,
          todos: cleanedTodos,
          regenerate: true,
          agentRunRequestId,
          useClientMessagesForRegenerate: shouldSendClientMessagesForRegenerate,
          sandboxPreference,
          agentPermissionMode: agentPermissionModeRef.current,
          selectedModel: requestSelectedModelRef.current,
        },
      }),
    );
  };

  const handleRetry = async (options: RetryOptions = {}) => {
    if (sendDisabledReasonRef.current || retryPendingRef.current) return;
    retryPendingRef.current = true;
    try {
      const lastUserId = messages
        .slice()
        .reverse()
        .find((message) => message.role === "user")?.id;
      const queuedAttempt = messageQueue.find(
        (message) => message.id === lastUserId && message.deliveryStatus,
      );
      if (queuedAttempt && sendQueuedMessage) {
        await handleSendNow(queuedAttempt.id, options);
        return;
      }
      if (
        isAgentMode(chatModeRef.current) &&
        getAutoContinueChainAssistantIds(messages).length > 0
      ) {
        try {
          await continueSavedTask(options);
        } catch {
          toast.error(
            "Could not resume. Your saved progress is still available.",
          );
        }
        return;
      }
      // Read authoritative state before mutating the transcript. A failed or
      // unavailable check must not turn a saved request into a new submission.
      let retryUnpersistedMessage = false;
      if (lastUserId) {
        try {
          retryUnpersistedMessage = isUserMessagePersisted
            ? !(await isUserMessagePersisted(lastUserId))
            : !isExistingChat;
        } catch {
          toast.error("Could not check the saved request. Please retry.");
          return;
        }
      }
      if (sendDisabledReasonRef.current) return;
      setIsAutoResuming(false);
      resetAutoContinueCount?.();

      // Stop any active stream first to prevent message order issues and wasted tokens
      if (hasActiveRunToReplace()) {
        if (!(await stopActiveRunForReplacement("retry"))) return;
      }
      if (sendDisabledReasonRef.current) return;
      const agentRunRequestId = uuidv4();

      const chainAssistantIds = getAutoContinueChainAssistantIds(messages);
      const cleanedTodos = removeTodosBySourceMessages(
        todos,
        todos
          .filter((t) => t.sourceMessageId)
          .map((t) => t.sourceMessageId as string),
      );
      if (cleanedTodos !== todos) setTodos(cleanedTodos);

      const messagesToLastUser = getMessagesUpToLastRealUser(messages);
      reconcileSidebar(messagesToLastUser);
      setMessages(messagesToLastUser);

      // Admission may fail before the user message is persisted. Retrying that
      // turn must save the same message ID instead of regenerating absent history.
      const shouldSendClientMessagesForRegenerate =
        retryUnpersistedMessage ||
        hasRestageableLocalDesktopAttachments(messagesToLastUser);
      const persistentRegenerateMessages = shouldSendClientMessagesForRegenerate
        ? messagesToLastUser
        : [];

      // Delete any persisted partial/error response before retrying. The backend
      // otherwise fetches that stale trailing chain when client messages are not
      // needed to restage local desktop attachments.
      if (chainAssistantIds.length > 0) {
        await deleteLastAssistantMessage({
          chatId,
          resetSummary: true,
          todos: cleanedTodos,
        });
      }

      if (sendDisabledReasonRef.current) return;
      await runChatAction("retry response", () =>
        regenerate({
          body: {
            mode: chatModeRef.current,
            messages: persistentRegenerateMessages,
            todos: cleanedTodos,
            regenerate: !retryUnpersistedMessage,
            agentRunRequestId,
            useClientMessagesForRegenerate:
              shouldSendClientMessagesForRegenerate,
            sandboxPreference,
            agentPermissionMode: agentPermissionModeRef.current,
            selectedModel: options.selectedModel ?? requestSelectedModel,
            ...(options.limitRescue && { limitRescue: options.limitRescue }),
          },
        }),
      );
    } finally {
      retryPendingRef.current = false;
    }
  };

  const handleEditMessage = async (
    messageId: string,
    newContent: string,
    remainingFileIds?: string[],
  ) => {
    if (sendDisabledReasonRef.current) return;
    const lastUserMessageIndex = findLastUserMessageIndex(messages);
    if (
      lastUserMessageIndex === undefined ||
      messages[lastUserMessageIndex]?.id !== messageId
    ) {
      toast.error("Only the latest user message can be edited.");
      return;
    }

    setIsAutoResuming(false);
    resetAutoContinueCount?.();

    // Stop any active stream first to prevent message order issues and wasted tokens
    if (hasActiveRunToReplace()) {
      if (!(await stopActiveRunForReplacement("edit"))) return;
    }
    if (sendDisabledReasonRef.current) return;
    const agentRunRequestId = uuidv4();

    // Compute the todo snapshot before the edit mutation. Stopping a run
    // persists its latest todos, so the same mutation that removes the old
    // response must also replace that snapshot to avoid a reactive chat update
    // restoring todos from the discarded response.
    const editedMessageIndex = messages.findIndex((m) => m.id === messageId);
    const discardedMessageIds =
      editedMessageIndex === -1
        ? []
        : messages.slice(editedMessageIndex + 1).map((message) => message.id);
    const cleanedTodosForEdit = removeTodosBySourceMessages(
      todos,
      discardedMessageIds,
    );

    try {
      await regenerateWithNewContent({
        messageId: messageId as Id<"messages">,
        newContent,
        fileIds: remainingFileIds,
        todos: cleanedTodosForEdit,
      });
    } catch (error) {
      if (getConvexErrorCode(error) === "MESSAGE_NOT_EDITABLE") {
        toast.error("Only the latest user message can be edited.");
        return;
      }

      throw error;
    }

    if (sendDisabledReasonRef.current) return;
    setTodos(cleanedTodosForEdit);
    reconcileSidebar(messages.slice(0, editedMessageIndex + 1));

    // Build updated parts: text + remaining file parts
    const buildUpdatedParts = (currentParts: any[]) => {
      const newParts: any[] = [];

      // Add text part if there's content
      if (newContent.trim()) {
        newParts.push({ type: "text", text: newContent });
      }

      // Keep file parts that are in remainingFileIds
      if (remainingFileIds && remainingFileIds.length > 0) {
        const remainingFileParts = currentParts.filter(
          (part) =>
            part.type === "file" &&
            part.fileId &&
            remainingFileIds.includes(part.fileId),
        );
        newParts.push(...remainingFileParts);
      }

      return newParts;
    };

    // Update local state to reflect the edit and remove subsequent messages
    setMessages((prevMessages) => {
      const editedMessageIndex = prevMessages.findIndex(
        (msg) => msg.id === messageId,
      );

      if (editedMessageIndex === -1) return prevMessages;

      const updatedMessages = prevMessages.slice(0, editedMessageIndex + 1);
      const currentMessage = updatedMessages[editedMessageIndex];
      updatedMessages[editedMessageIndex] = {
        ...currentMessage,
        parts: buildUpdatedParts(currentMessage.parts),
      };

      return updatedMessages;
    });

    runChatAction("regenerate edited message", () =>
      regenerate({
        body: {
          mode: chatModeRef.current,
          messages: [],
          todos: cleanedTodosForEdit,
          regenerate: true,
          agentRunRequestId,
          sandboxPreference,
          agentPermissionMode: agentPermissionModeRef.current,
          selectedModel: requestSelectedModel,
        },
      }),
    );
  };

  const continueSavedTask = async (options: RetryOptions = {}) => {
    if (sendDisabledReasonRef.current || recoveryPendingRef.current) return;
    if (statusRef.current === "streaming" || statusRef.current === "submitted")
      return;
    recoveryPendingRef.current = true;
    const requestGeneration = getAgentRunRequestGeneration?.();
    const isCurrentRequest = () =>
      currentChatIdRef.current === chatId &&
      getAgentRunRequestGeneration?.() === requestGeneration;
    let partialSaveRejected = false;
    try {
      if (isAgentMode(chatModeRef.current)) {
        // An interrupted browser connection does not mean the worker stopped.
        await getPendingAgentLongRunStart(chatId);
        if (!isCurrentRequest() || sendDisabledReasonRef.current) return;
        const response = await fetch(
          `${AGENT_RESUME_ENDPOINT}?chatId=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        if (!isCurrentRequest() || sendDisabledReasonRef.current) return;
        if (response.status === 200) {
          if (!resumeActiveRun)
            throw new Error("Could not reconnect to the active Agent run.");
          await resumeActiveRun();
          return;
        }
        if (response.status !== 204)
          throw new Error("Could not check the Agent run. Try again.");
        // The next run loads its context from Convex, so it must not race a
        // client fallback save that is still in flight (or previously failed).
        partialSaveRejected = (await prepareAgentRecovery?.()) === true;
        if (!isCurrentRequest() || sendDisabledReasonRef.current) return;
      }
      if (partialSaveRejected) {
        toast.warning(
          "Some recent output could not be saved. Resuming from the last saved progress.",
        );
      }
      hasManuallyStoppedRef.current = false;
      setIsAutoResuming(false);
      resetAutoContinueCount?.();
      await sendMessage(
        {
          text: partialSaveRejected
            ? `${AUTO_CONTINUE_PROMPT} Some recent streamed output could not be saved. Inspect the current state before repeating any action whose outcome is uncertain.`
            : AUTO_CONTINUE_PROMPT,
          metadata: { isAutoContinue: true },
        },
        {
          body: {
            mode: chatModeRef.current,
            isAutoContinue: true,
            todos: todosRef.current,
            sandboxPreference: sandboxPreferenceRef.current,
            desktopEnvironmentId: desktopEnvironmentIdRef.current,
            agentPermissionMode: agentPermissionModeRef.current,
            selectedModel:
              options.selectedModel ?? requestSelectedModelRef.current,
            ...(options.limitRescue && { limitRescue: options.limitRescue }),
          },
        },
      );
    } finally {
      recoveryPendingRef.current = false;
    }
  };

  const handleContinue = (
    selectedModelOverride?: SelectedModel,
    limitRescue?: LimitRescueRequest,
  ) => continueSavedTask({ selectedModel: selectedModelOverride, limitRescue });

  const handleSendNow = async (
    messageId: string,
    options: RetryOptions = {},
  ) => {
    if (sendDisabledReasonRef.current) return;
    const message = messageQueue.find((m) => m.id === messageId);
    if (!message || message.deliveryStatus === "sending") return;
    if (isSummarizingRef.current) {
      hasManuallyStoppedRef.current = false;
      setSummarySteer({ chatId, messageId, options });
      return;
    }
    if (isSendingNowRef.current) return;
    const stopGeneration = stopGenerationRef.current;
    resetAutoContinueCount?.();

    // Set flag to prevent auto-processing from interfering
    isSendingNowRef.current = true;

    // Reset manual stop flag when using Send Now
    hasManuallyStoppedRef.current = false;

    try {
      setIsAutoResuming(false);
      if (!message.deliveryStatus && hasActiveRunToReplace()) {
        if (!(await stopActiveRunForSteer("send_now"))) return;
      }

      if (
        sendDisabledReasonRef.current ||
        currentChatIdRef.current !== chatId ||
        stopGenerationRef.current !== stopGeneration
      )
        return;
      if (
        sendQueuedMessage &&
        (chatModeRef.current === "agent" || message.deliveryStatus)
      ) {
        await sendQueuedMessage(messageId, {
          mode: chatModeRef.current,
          todos,
          sandboxPreference,
          agentPermissionMode: agentPermissionModeRef.current,
          selectedModel:
            options.selectedModel ?? requestSelectedModelRef.current,
          ...(options.limitRescue && { limitRescue: options.limitRescue }),
        });
        return;
      }

      // Keep the queued message available if stopping fails.
      removeQueuedMessage(messageId);

      // Send the queued message immediately
      const validFiles = message.files || [];
      const messagePayload: any = {};

      // Only add text if it exists
      if (message.text) {
        messagePayload.text = message.text;
      }

      // Only add files if they exist
      if (validFiles.length > 0) {
        messagePayload.files = validFiles;
      }

      messagePayload.metadata = { createdAt: message.timestamp };

      runChatAction("send queued message", () =>
        sendMessage(messagePayload, {
          body: {
            mode: chatModeRef.current,
            todos,
            sandboxPreference,
            agentPermissionMode: agentPermissionModeRef.current,
            selectedModel: requestSelectedModel,
          },
        }),
      );
    } catch (error) {
      console.error("Failed to send queued message:", error);
      toast.error("Could not steer the Agent run. Please try again.");
    } finally {
      // Clear flag after a brief delay to allow status to change
      setTimeout(() => {
        isSendingNowRef.current = false;
        setSendNowReleaseVersion((version) => version + 1);
      }, 200);
    }
  };

  const handleSendNowRef = useCommittedRef(handleSendNow);
  useEffect(() => {
    if (!summarySteer || summarySteer.chatId !== chatId) return;
    const message = messageQueue.find(
      (item) => item.id === summarySteer.messageId,
    );
    if (!message) {
      setSummarySteer(null);
      return;
    }
    if (
      isSummarizing ||
      sendDisabledReason ||
      editingQueuedMessageId != null ||
      hasManuallyStoppedRef.current ||
      isSendingNowRef.current
    ) {
      return;
    }

    setSummarySteer(null);
    // Use the latest handler/messages/todos after the completion event, rather
    // than the snapshot from when the user submitted during compaction.
    void handleSendNowRef.current(message.id, summarySteer.options);
  }, [
    summarySteer,
    chatId,
    isSummarizing,
    sendDisabledReason,
    editingQueuedMessageId,
    hasManuallyStoppedRef,
    messageQueue,
    handleSendNowRef,
    isSendingNowRef,
    sendNowReleaseVersion,
  ]);

  return {
    hasPendingSummarySteer: summarySteer?.chatId === chatId,
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
    handleSendNow,
    handleContinue,
  };
};
