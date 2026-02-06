"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { readUIMessageStream } from "ai";
import { RefObject, useRef, useEffect, useState, useCallback } from "react";
import { useRealtimeStream, useRealtimeRun } from "@trigger.dev/react-hooks";
import { runs } from "@trigger.dev/sdk/v3";
import {
  aiStream,
  metadataStream,
  type MetadataEvent,
} from "@/src/trigger/streams";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FileDetails } from "@/types/file";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import type { RateLimitWarningData } from "./RateLimitWarning";
import { ComputerSidebar } from "./ComputerSidebar";
import ChatHeader from "./ChatHeader";
import MainSidebar from "./Sidebar";
import Footer from "./Footer";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useMessageScroll } from "../hooks/useMessageScroll";
import { useChatHandlers } from "../hooks/useChatHandlers";
import { useGlobalState } from "../contexts/GlobalState";
import { useFileUpload } from "../hooks/useFileUpload";
import { useDocumentDragAndDrop } from "../hooks/useDocumentDragAndDrop";
import { DragDropOverlay } from "./DragDropOverlay";
import { normalizeMessages } from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage, ChatMode, SubscriptionTier } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";
import { shouldTreatAsMerge } from "@/lib/utils/todo-utils";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";
import { useAutoResume } from "../hooks/useAutoResume";
import { useLatestRef } from "../hooks/useLatestRef";
import { useDataStream } from "./DataStreamProvider";
import { removeDraft } from "@/lib/utils/client-storage";

export const Chat = ({
  chatId: routeChatId,
  autoResume,
}: {
  chatId?: string;
  autoResume: boolean;
}) => {
  const isMobile = useIsMobile();
  const { setDataStream, setIsAutoResuming } = useDataStream();
  const [uploadStatus, setUploadStatus] = useState<{
    message: string;
    isUploading: boolean;
  } | null>(null);
  const [summarizationStatus, setSummarizationStatus] = useState<{
    status: "started" | "completed";
    message: string;
  } | null>(null);
  const [rateLimitWarning, setRateLimitWarning] =
    useState<RateLimitWarningData | null>(null);

  const {
    chatTitle,
    setChatTitle,
    chatMode,
    setChatMode,
    sidebarOpen,
    chatSidebarOpen,
    setChatSidebarOpen,
    mergeTodos,
    setTodos,
    replaceAssistantTodos,
    currentChatId,
    setCurrentChatId,
    temporaryChatsEnabled,
    setChatReset,
    hasUserDismissedRateLimitWarning,
    setHasUserDismissedRateLimitWarning,
    messageQueue,
    dequeueNext,
    clearQueue,
    queueBehavior,
    todos,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  // Simple logic: use route chatId if provided, otherwise generate new one
  const [chatId, setChatId] = useState<string>(() => {
    return routeChatId || uuidv4();
  });

  // Track whether this is an existing chat (prop-driven initially, flips after first completion)
  const [isExistingChat, setIsExistingChat] = useState<boolean>(!!routeChatId);
  const shouldFetchMessages = isExistingChat;

  // Refs to avoid stale closures in callbacks
  const isExistingChatRef = useLatestRef(isExistingChat);
  const chatModeRef = useLatestRef(chatMode);

  // Suppress transient "Chat Not Found" while server creates the chat
  const [awaitingServerChat, setAwaitingServerChat] = useState<boolean>(false);

  // Store file metadata separately from AI SDK message state (for temporary chats)
  const [tempChatFileDetails, setTempChatFileDetails] = useState<
    Map<string, FileDetails[]>
  >(new Map());

  // Skip paginatedMessages sync after Trigger completion until Convex has caught up
  const skipPaginatedSyncUntilRef = useRef<number>(0);
  // Track the last assistant message ID from trigger to verify Convex sync
  const lastTriggerAssistantIdRef = useRef<string | null>(null);

  // Trigger.dev agent streaming (agent mode, non-temporary only)
  const [triggerRun, setTriggerRun] = useState<{
    runId: string;
    publicAccessToken: string;
  } | null>(null);
  const [triggerBaseAndUserMessages, setTriggerBaseAndUserMessages] = useState<
    ChatMessage[]
  >([]);
  const [triggerAssistantMessage, setTriggerAssistantMessage] =
    useState<ChatMessage | null>(null);
  const [triggerStatus, setTriggerStatus] = useState<
    "streaming" | "ready" | "error"
  >("ready");

  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  // Use global state ref so streaming callback reads latest value
  const hasUserDismissedWarningRef = useLatestRef(
    hasUserDismissedRateLimitWarning,
  );
  // Use ref for todos to avoid stale closures in auto-send
  const todosRef = useLatestRef(todos);
  // Use ref for sandbox preference to avoid stale closures in auto-send
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);

  // Ensure we only initialize mode from server once per chat id
  const hasInitializedModeFromChatRef = useRef(false);

  // Unified reset: respond to route and global new-chat trigger
  useEffect(() => {
    // If global state indicates a new chat, prefer that over any stale route id
    if (currentChatId === null) {
      if (routeChatId) {
        return;
      }
      setChatId(uuidv4());
      setIsExistingChat(false);
      setChatTitle(null);
      // Messages will be cleared below after useChat is ready
      return;
    }

    // If a chat id is present in the route, treat as existing chat
    if (routeChatId) {
      setChatId(routeChatId);
      setIsExistingChat(true);
      return;
    }
  }, [routeChatId, currentChatId, setChatTitle]);

  // Use paginated query to load messages in batches of 14
  const paginatedMessages = usePaginatedQuery(
    api.messages.getMessagesByChatId,
    shouldFetchMessages ? { chatId } : "skip",
    { initialNumItems: 14 },
  );

  // Get chat data to retrieve title when loading existing chat
  const chatData = useQuery(
    api.chats.getChatByIdFromClient,
    shouldFetchMessages ? { id: chatId } : "skip",
  );

  // Convert paginated Convex messages to UI format for useChat
  // Messages come from server in descending order (newest first from pagination)
  // We need to reverse them to show chronological order (oldest first)
  const initialMessages: ChatMessage[] =
    paginatedMessages.results && paginatedMessages.results.length > 0
      ? convertToUIMessages([...paginatedMessages.results].reverse())
      : [];

  // State to prevent double-processing of queue
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  // Ref to track when "Send Now" is actively processing to prevent auto-processing interference
  const isSendingNowRef = useRef(false);
  // Ref to track if user manually stopped - prevents auto-processing until new message submitted
  const hasManuallyStoppedRef = useRef(false);

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
    resumeStream,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    experimental_throttle: 100,
    generateId: () => uuidv4(),

    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
        // Dynamically route to correct API based on current mode
        const url =
          input === "/api/chat" && chatModeRef.current === "agent"
            ? "/api/agent-stream"
            : input;
        return fetchWithErrorHandlers(url, init);
      },
      prepareSendMessagesRequest: ({ id, messages, body }) => {
        const {
          messages: normalizedMessages,
          lastMessage,
          hasChanges,
        } = normalizeMessages(messages as ChatMessage[]);
        if (hasChanges) {
          setMessages(normalizedMessages);
        }

        const isTemporaryChat =
          !isExistingChatRef.current && temporaryChatsEnabledRef.current;

        // Strip URLs from file parts before sending to backend
        // This ensures backend always generates fresh URLs (prevents 403 errors from expired URLs)
        // Backend will fetch URLs using fileId, supporting both S3 and Convex storage
        const stripUrlsFromMessages = (msgs: ChatMessage[]): ChatMessage[] => {
          return msgs.map((msg) => {
            if (!msg.parts || msg.parts.length === 0) return msg;
            const strippedParts = msg.parts.map((part: any) => {
              if (part.type === "file" && "url" in part) {
                // Remove URL property, keeping all other file metadata
                const { url, ...partWithoutUrl } = part;
                return partWithoutUrl;
              }
              return part;
            });
            return {
              ...msg,
              parts: strippedParts,
            };
          });
        };

        const messagesToSend = isTemporaryChat
          ? normalizedMessages
          : lastMessage;
        const messagesWithoutUrls = stripUrlsFromMessages(messagesToSend);

        return {
          body: {
            chatId: id,
            messages: messagesWithoutUrls,
            ...body,
          },
        };
      },
    }),

    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
      if (dataPart.type === "data-title")
        setChatTitle((dataPart.data as { chatTitle: string }).chatTitle);
      if (dataPart.type === "data-upload-status") {
        const uploadData = dataPart.data as {
          message: string;
          isUploading: boolean;
        };
        setUploadStatus(uploadData.isUploading ? uploadData : null);
      }
      if (dataPart.type === "data-summarization") {
        const summaryData = dataPart.data as {
          status: "started" | "completed";
          message: string;
        };
        // Show shimmer while started, clear when completed
        setSummarizationStatus(
          summaryData.status === "started" ? summaryData : null,
        );
      }
      if (dataPart.type === "data-rate-limit-warning") {
        const rawData = dataPart.data as {
          warningType: "sliding-window" | "token-bucket" | "extra-usage-active";
          resetTime: string;
          subscription: SubscriptionTier;
          // sliding-window fields
          remaining?: number;
          mode?: ChatMode;
          // token-bucket and extra-usage-active fields
          bucketType?: "session" | "weekly";
          // token-bucket only
          remainingPercent?: number;
        };

        // Only show or update warning if user hasn't dismissed it
        if (!hasUserDismissedWarningRef.current) {
          if (rawData.warningType === "sliding-window") {
            setRateLimitWarning({
              warningType: "sliding-window",
              remaining: rawData.remaining!,
              resetTime: new Date(rawData.resetTime),
              mode: rawData.mode!,
              subscription: rawData.subscription,
            });
          } else if (rawData.warningType === "extra-usage-active") {
            // Only show extra usage warning once per reset period (localStorage tracks this)
            const storageKey = `extraUsageWarningShownUntil_${rawData.bucketType}`;
            const storedResetTime = localStorage.getItem(storageKey);

            // Show warning only if we haven't shown it for this period
            if (!storedResetTime || new Date(storedResetTime) < new Date()) {
              localStorage.setItem(storageKey, rawData.resetTime);
              setRateLimitWarning({
                warningType: "extra-usage-active",
                bucketType: rawData.bucketType!,
                resetTime: new Date(rawData.resetTime),
                subscription: rawData.subscription,
              });
            }
          } else {
            setRateLimitWarning({
              warningType: "token-bucket",
              bucketType: rawData.bucketType!,
              remainingPercent: rawData.remainingPercent!,
              resetTime: new Date(rawData.resetTime),
              subscription: rawData.subscription,
            });
          }
        }
      }
      if (dataPart.type === "data-file-metadata") {
        const fileData = dataPart.data as {
          messageId: string;
          fileDetails: FileDetails[];
        };

        // Store in parallel state (outside AI SDK control)
        setTempChatFileDetails((prev) => {
          const next = new Map(prev);
          next.set(fileData.messageId, fileData.fileDetails);
          return next;
        });
      }
      if (dataPart.type === "data-sandbox-fallback") {
        const fallbackData = dataPart.data as {
          occurred: boolean;
          reason: "connection_unavailable" | "no_local_connections";
          requestedPreference: string;
          actualSandbox: string;
          actualSandboxName?: string;
        };

        // Update sandbox preference to match actual sandbox used
        setSandboxPreference(fallbackData.actualSandbox);

        // Show toast notification
        const message =
          fallbackData.reason === "no_local_connections"
            ? `Local sandbox unavailable. Using ${fallbackData.actualSandboxName || "Cloud"}.`
            : `Selected sandbox disconnected. Switched to ${fallbackData.actualSandboxName || "Cloud"}.`;
        toast.info(message, { duration: 5000 });
      }
    },
    onToolCall: ({ toolCall }) => {
      if (toolCall.toolName === "todo_write" && toolCall.input) {
        const todoInput = toolCall.input as { merge?: boolean; todos: Todo[] };
        if (!todoInput.todos) return;
        // Determine last assistant message id to stamp/replace
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const lastAssistantId = lastAssistant?.id;

        const treatAsMerge = shouldTreatAsMerge(
          todoInput.merge,
          todoInput.todos,
        );

        if (!treatAsMerge) {
          // Fresh plan creation: replace assistant todos with new ones, stamp with current assistant id if present.
          replaceAssistantTodos(todoInput.todos, lastAssistantId);
        } else {
          // Partial update: merge
          mergeTodos(todoInput.todos);
        }
      }
    },
    onFinish: () => {
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      setSummarizationStatus(null);
      // For new chats, flip the state so it becomes an existing chat
      const isTemporaryChat =
        !isExistingChatRef.current && temporaryChatsEnabledRef.current;
      if (!isExistingChatRef.current && !isTemporaryChat) {
        setIsExistingChat(true);
        // Clear the "new" draft when transitioning from new chat to existing chat
        removeDraft("new");
      }
    },
    onError: (error) => {
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      setSummarizationStatus(null);
      if (error instanceof ChatSDKError && error.type !== "rate_limit") {
        toast.error(error.message);
      }
    },
  });

  // Trigger.dev realtime streams (agent mode, non-temporary)
  const { parts: aiParts = [] } = useRealtimeStream(
    aiStream,
    triggerRun?.runId ?? "",
    {
      accessToken: triggerRun?.publicAccessToken ?? "",
      enabled: !!triggerRun,
      throttleInMs: 16,
      timeoutInSeconds: 600,
    },
  );
  useRealtimeStream(metadataStream, triggerRun?.runId ?? "", {
    accessToken: triggerRun?.publicAccessToken ?? "",
    enabled: !!triggerRun,
    onData: (event: MetadataEvent) => {
      setDataStream((ds) => (ds ? [...ds, event] : []));
      if (event.type === "data-title")
        setChatTitle((event.data as { chatTitle: string }).chatTitle);
      if (event.type === "data-upload-status") {
        const d = event.data as { message: string; isUploading: boolean };
        setUploadStatus(d.isUploading ? d : null);
      }
      if (event.type === "data-summarization") {
        const d = event.data as {
          status: "started" | "completed";
          message: string;
        };
        setSummarizationStatus(d.status === "started" ? d : null);
      }
      if (event.type === "data-rate-limit-warning") {
        const rawData = event.data as Record<string, unknown>;
        if (
          !hasUserDismissedWarningRef.current &&
          rawData &&
          typeof rawData.resetTime === "string"
        )
          setRateLimitWarning({
            ...rawData,
            resetTime: new Date(rawData.resetTime),
          } as RateLimitWarningData);
      }
      if (event.type === "data-file-metadata") {
        const d = event.data as {
          messageId: string;
          fileDetails: FileDetails[];
        };
        setTempChatFileDetails((prev) => {
          const next = new Map(prev);
          next.set(d.messageId, d.fileDetails);
          return next;
        });
      }
      if (event.type === "data-sandbox-fallback") {
        const d = event.data as {
          actualSandbox?: string;
          actualSandboxName?: string;
        };
        if (d?.actualSandbox) setSandboxPreference(d.actualSandbox);
        toast.info(
          d?.actualSandboxName
            ? `Using ${d.actualSandboxName}.`
            : "Sandbox switched.",
          { duration: 5000 },
        );
      }
    },
  });
  const { run: triggerRunStatus } = useRealtimeRun(
    triggerRun?.runId ?? undefined,
    {
      accessToken: triggerRun?.publicAccessToken ?? "",
      enabled: !!triggerRun,
    },
  );

  // Derive triggerStatus from run and sync triggerAssistantMessage from aiParts
  useEffect(() => {
    if (!triggerRun) return;
    const status =
      triggerRunStatus?.status === "EXECUTING"
        ? "streaming"
        : triggerRunStatus?.status === "COMPLETED"
          ? "ready"
          : triggerRunStatus?.status === "FAILED" ||
              triggerRunStatus?.status === "CANCELED"
            ? "error"
            : "streaming";
    setTriggerStatus(status);
  }, [triggerRun, triggerRunStatus?.status]);

  // Convert aiParts to assistant message for display (update on each chunk for progressive streaming)
  // Use generation counter instead of AbortController to avoid cancelling the stream mid-read
  // (cancellation triggers "Cannot close an errored readable stream" in AI SDK)
  // Throttle updates to reduce scroll fighting during rapid streaming
  const aiPartsGenerationRef = useRef(0);
  useEffect(() => {
    if (!triggerRun || aiParts.length === 0) {
      if (!triggerRun) setTriggerAssistantMessage(null);
      return;
    }

    const generation = ++aiPartsGenerationRef.current;

    type Chunk = import("ai").UIMessageChunk;
    const stream = new ReadableStream<Chunk>({
      start(controller) {
        try {
          (aiParts as Chunk[]).forEach((chunk: Chunk) =>
            controller.enqueue(chunk),
          );
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    const throttleMs = 100;
    let pending: ChatMessage | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const flushPending = () => {
      if (pending !== null && generation === aiPartsGenerationRef.current) {
        setTriggerAssistantMessage(pending);
        pending = null;
      }
      timeoutId = null;
    };

    void (async () => {
      try {
        for await (const msg of readUIMessageStream({ stream })) {
          if (generation !== aiPartsGenerationRef.current) return;

          pending = msg as ChatMessage;
          if (timeoutId === null) {
            timeoutId = setTimeout(flushPending, throttleMs);
          }
        }
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (pending !== null && generation === aiPartsGenerationRef.current) {
          setTriggerAssistantMessage(pending);
          pending = null;
        }
      } catch {
        if (generation === aiPartsGenerationRef.current) {
          setTriggerAssistantMessage(null);
        }
      }
    })();

    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [triggerRun, aiParts]);

  // When trigger run completes, sync messages and clear trigger state
  useEffect(() => {
    if (!triggerRun || triggerStatus !== "ready") return;

    // Set skip timer FIRST (before any state updates) to prevent Convex sync race condition
    skipPaginatedSyncUntilRef.current = Date.now() + 3000;

    const fullMessages = [
      ...triggerBaseAndUserMessages,
      ...(triggerAssistantMessage ? [triggerAssistantMessage] : []),
    ];
    setMessages(fullMessages);

    // Track the assistant message ID so Convex sync can verify it before overwriting
    const assistantMsg = triggerAssistantMessage;
    if (assistantMsg) {
      lastTriggerAssistantIdRef.current = assistantMsg.id;
    }

    setTriggerRun(null);
    setTriggerBaseAndUserMessages([]);
    setTriggerAssistantMessage(null);
    setTriggerStatus("ready");
    setIsAutoResuming(false);
    setAwaitingServerChat(false);
    setUploadStatus(null);
    setSummarizationStatus(null);

    if (!isExistingChatRef.current) {
      setIsExistingChat(true);
      removeDraft("new");
      setCurrentChatId(chatId);
      // Use replaceState to update URL without unmounting - keeps messages in state.
      // Reload will load /c/[chatId] and fetch from Convex.
      window.history.replaceState({}, "", `/c/${chatId}`);
    }
  }, [
    triggerRun,
    triggerStatus,
    triggerBaseAndUserMessages,
    triggerAssistantMessage,
    setMessages,
    setCurrentChatId,
    chatId,
  ]);

  // Auto-resume controlled by prop; default to true when a specific chat id is present, false on "/"
  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  // Register a reset function with global state so initializeNewChat can call it
  useEffect(() => {
    const reset = () => {
      setMessages([]);
      setIsExistingChat(false);
      setChatId(uuidv4());
      setChatTitle(null);
      setTodos([]);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      setSummarizationStatus(null);
      setTriggerRun(null);
      setTriggerBaseAndUserMessages([]);
      setTriggerAssistantMessage(null);
      setTriggerStatus("ready");
      lastTriggerAssistantIdRef.current = null;
    };
    setChatReset(reset);
    return () => setChatReset(null);
  }, [setChatReset, setMessages, setChatTitle, setTodos]);

  // Set chat title and load todos when chat data is loaded
  useEffect(() => {
    // Only process when we intend to fetch for an existing chat
    if (!shouldFetchMessages) {
      return;
    }

    const dataId = (chatData as any)?.id as string | undefined;
    // Ignore when no data or data is stale (doesn't match current chatId)
    if (!chatData || dataId !== chatId) {
      return;
    }

    if (chatData.title) {
      // Always update title from server data to ensure consistency
      setChatTitle(chatData.title);
    }

    // Load todos from the chat data if they exist.
    if (chatData.todos) {
      // setTodos signature expects Todo[], so derive the new array first
      const nextTodos: Todo[] = (() => {
        const incoming: Todo[] = chatData.todos as Todo[];
        if (!incoming || incoming.length === 0) return [] as Todo[];

        // Split by assistant attribution
        const incomingAssistant: Todo[] = incoming.filter((t: Todo) =>
          Boolean(t.sourceMessageId),
        );
        const incomingManual: Todo[] = incoming.filter(
          (t: Todo) => !t.sourceMessageId,
        );

        const prevManual: Todo[] = [];
        // We can't access previous value directly here without functional setter.
        // Fallback: since server is source of truth, treat incoming manual todos as updates only for ids we already have.
        // The actual merge of manual todos will be handled elsewhere when tool updates come in.

        // Build manual map from previous
        // Replace assistant todos entirely with incoming assistant todos and keep incoming manual ones as-is
        return [...incomingAssistant, ...incomingManual] as Todo[];
      })();

      setTodos(nextTodos);
    }
    // Server has responded for this chat id; stop suppressing not-found state
    setAwaitingServerChat(false);
    // Initialize mode from server once per chat id (only for existing chats)
    if (!hasInitializedModeFromChatRef.current && isExistingChat) {
      const slug = (chatData as any).default_model_slug;
      if (slug === "ask" || slug === "agent") {
        setChatMode(slug);
        hasInitializedModeFromChatRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatData,
    setChatTitle,
    setTodos,
    shouldFetchMessages,
    isExistingChat,
    chatId,
  ]);

  // Reset the one-time initializer when chat changes
  useEffect(() => {
    hasInitializedModeFromChatRef.current = false;
    lastTriggerAssistantIdRef.current = null; // Clear trigger tracking when switching chats
  }, [chatId]);

  // Sync Convex real-time data with useChat messages
  useEffect(() => {
    // Skip sync while streaming (messages come from streaming state, not Convex)
    if (triggerRun) {
      return;
    }
    // Also skip if useChat is streaming (for temporary chats or fallback path)
    if (status === "streaming") {
      return;
    }

    if (Date.now() < skipPaginatedSyncUntilRef.current) {
      return;
    }
    if (!paginatedMessages.results || paginatedMessages.results.length === 0) {
      return;
    }

    // Messages come from server in descending order, reverse for chronological display
    const uiMessages = convertToUIMessages(
      [...paginatedMessages.results].reverse(),
    );

    // Simple sync: always use server messages for existing chats
    // BUT: If we just completed a Trigger.dev run, verify the assistant message exists in Convex
    // before overwriting (prevents race condition where Convex hasn't propagated the new message yet)
    if (isExistingChat) {
      const lastTriggerId = lastTriggerAssistantIdRef.current;
      if (lastTriggerId) {
        // Check if Convex has the assistant message from the trigger run
        const hasAssistantMessage = uiMessages.some(
          (msg) => msg.id === lastTriggerId,
        );
        if (hasAssistantMessage) {
          // Convex has caught up, safe to sync
          setMessages(uiMessages);
          lastTriggerAssistantIdRef.current = null; // Clear the ref
        }
        // If Convex doesn't have it yet, skip this sync and wait for next update
      } else {
        // No pending trigger completion, safe to sync normally
        setMessages(uiMessages);
      }
    }
  }, [
    paginatedMessages.results,
    setMessages,
    isExistingChat,
    chatId,
    triggerRun,
    status,
  ]);

  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useMessageScroll();

  // File upload with drag and drop support
  const {
    isDragOver,
    showDragOverlay,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileUpload(chatMode);

  // Handle instant scroll to bottom when loading existing chat messages
  useEffect(() => {
    if (isExistingChat && messages.length > 0) {
      scrollToBottom({ instant: true, force: true });
    }
  }, [messages.length, scrollToBottom, isExistingChat]);

  const displayStatusForQueue = triggerRun ? triggerStatus : status;

  // Keep a ref to the latest messageQueue to avoid stale closures
  const messageQueueRef = useRef(messageQueue);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  // Clear queue when switching from Agent to Ask mode
  useEffect(() => {
    if (chatMode === "ask" && messageQueueRef.current.length > 0) {
      clearQueue();
    }
  }, [chatMode, clearQueue]);

  // Clear queue when navigating to a different chat
  useEffect(() => {
    return () => {
      if (messageQueueRef.current.length > 0) {
        clearQueue();
      }
    };
  }, [chatId, clearQueue]);

  // Document-level drag and drop listeners encapsulated in a hook
  useDocumentDragAndDrop({
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  });

  // Trigger.dev submit (agent mode, non-temporary): POST /api/agent, then stream via useRealtimeStream
  const triggerSubmit = useCallback(
    async (
      messagePayload: {
        text?: string;
        files?: Array<{
          type: "file";
          filename: string;
          mediaType: string;
          url: string;
          fileId: Id<"files">;
        }>;
      },
      options?: { body?: Record<string, unknown> },
    ) => {
      const parts: ChatMessage["parts"] = [];
      if (messagePayload.text)
        parts.push({ type: "text", text: messagePayload.text });
      (messagePayload.files ?? []).forEach((f) => {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          filename: f.filename,
          url: f.url,
          ...(f.fileId && { fileId: f.fileId }),
        } as ChatMessage["parts"][0]);
      });
      const newUserMessage: ChatMessage = {
        id: uuidv4(),
        role: "user",
        parts,
      };
      const fullMessages: ChatMessage[] = [...messages, newUserMessage];
      const stripUrls = (msgs: ChatMessage[]) =>
        msgs.map((msg) => {
          if (!msg.parts?.length) return msg;
          const strippedParts = msg.parts.map((part) => {
            if (part.type === "file" && "url" in part) {
              const { url: _u, ...rest } = part;
              return rest;
            }
            return part;
          });
          return { ...msg, parts: strippedParts };
        });
      try {
        const res = await fetchWithErrorHandlers("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            messages: stripUrls(fullMessages),
            mode: "agent",
            todos: options?.body?.todos ?? todos,
            temporary: false,
            sandboxPreference:
              options?.body?.sandboxPreference ?? sandboxPreference,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          toast.error(err?.message ?? "Failed to start agent");
          return;
        }
        const { runId, publicAccessToken } = await res.json();
        // Clear any pending skip timer from previous streams before starting new one
        skipPaginatedSyncUntilRef.current = 0;
        setTriggerRun({ runId, publicAccessToken });
        setTriggerBaseAndUserMessages(fullMessages as ChatMessage[]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("streaming");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to start agent");
      }
    },
    [messages, chatId, todos, sandboxPreference],
  );

  /** Trigger a new run for regenerate (agent mode, non-temporary). Backend fetches messages from DB. */
  const triggerRegenerate = useCallback(
    async (opts?: {
      body?: { todos?: Todo[]; sandboxPreference?: string };
    }) => {
      const cleanedTodos = opts?.body?.todos ?? todos;
      const pref = opts?.body?.sandboxPreference ?? sandboxPreference;
      try {
        const res = await fetchWithErrorHandlers("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            messages: [],
            mode: "agent",
            todos: cleanedTodos,
            regenerate: true,
            temporary: false,
            sandboxPreference: pref,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          toast.error(err?.message ?? "Failed to regenerate");
          return;
        }
        const { runId, publicAccessToken } = await res.json();
        // Clear any pending skip timer from previous streams before starting new one
        skipPaginatedSyncUntilRef.current = 0;
        setTriggerRun({ runId, publicAccessToken });
        setTriggerBaseAndUserMessages(messages.slice(0, -1) as ChatMessage[]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("streaming");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to regenerate");
      }
    },
    [messages, chatId, todos, sandboxPreference],
  );

  const wrappedSendMessage = useCallback(
    (payload: unknown, opts?: { body?: Record<string, unknown> }) => {
      if (
        chatMode === "agent" &&
        !temporaryChatsEnabled &&
        triggerRun === null
      ) {
        triggerSubmit(payload as Parameters<typeof triggerSubmit>[0], opts);
        return;
      }
      sendMessage(payload as Parameters<typeof sendMessage>[0], opts);
    },
    [chatMode, temporaryChatsEnabled, triggerRun, triggerSubmit, sendMessage],
  );

  const wrappedRegenerate = useCallback(
    (opts?: { body?: Record<string, unknown> }) => {
      if (chatMode === "agent" && !temporaryChatsEnabled) {
        triggerRegenerate(opts);
        return;
      }
      regenerate(opts);
    },
    [chatMode, temporaryChatsEnabled, triggerRegenerate, regenerate],
  );

  // Automatic queue processing - send next queued message when ready (uses wrappedSendMessage to route to Trigger.dev when agent + non-temporary)
  useEffect(() => {
    if (
      displayStatusForQueue === "ready" &&
      messageQueue.length > 0 &&
      !isProcessingQueue &&
      !isSendingNowRef.current &&
      !hasManuallyStoppedRef.current &&
      chatMode === "agent" &&
      queueBehavior === "queue"
    ) {
      setIsProcessingQueue(true);
      const nextMessage = dequeueNext();

      if (nextMessage) {
        wrappedSendMessage(
          {
            text: nextMessage.text,
            files: nextMessage.files
              ? nextMessage.files.map((f) => ({
                  type: "file" as const,
                  filename: f.file.name,
                  mediaType: f.file.type,
                  url: f.url,
                  fileId: f.fileId,
                }))
              : undefined,
          },
          {
            body: {
              mode: chatMode,
              todos: todosRef.current,
              temporary: temporaryChatsEnabledRef.current,
              sandboxPreference: sandboxPreferenceRef.current,
            },
          },
        );
      }

      setTimeout(() => setIsProcessingQueue(false), 100);
    }
  }, [
    displayStatusForQueue,
    messageQueue.length,
    isProcessingQueue,
    chatMode,
    dequeueNext,
    wrappedSendMessage,
    queueBehavior,
  ]);

  // Chat handlers
  const {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
    handleSendNow,
  } = useChatHandlers({
    chatId,
    messages: triggerRun
      ? [
          ...triggerBaseAndUserMessages,
          ...(triggerAssistantMessage ? [triggerAssistantMessage] : []),
        ]
      : messages,
    sendMessage: wrappedSendMessage,
    stop: useCallback(() => {
      if (triggerRun) {
        runs.cancel(triggerRun.runId).catch(() => {});
        setTriggerRun(null);
        setTriggerBaseAndUserMessages([]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("ready");
      } else {
        stop();
      }
    }, [triggerRun, stop]),
    regenerate: wrappedRegenerate,
    setMessages,
    isExistingChat,
    activateChatLocally: () => {
      setIsExistingChat(true);
      setAwaitingServerChat(true);
    },
    status: triggerRun ? triggerStatus : status,
    isSendingNowRef,
    hasManuallyStoppedRef,
    onStopCallback: () => {
      setUploadStatus(null);
      setSummarizationStatus(null);
    },
  });

  const handleScrollToBottom = () => scrollToBottom({ force: true });

  // Rate limit warning dismiss handler
  const handleDismissRateLimitWarning = () => {
    setRateLimitWarning(null);
    setHasUserDismissedRateLimitWarning(true);
  };

  // Branch chat handler
  const branchChatMutation = useMutation(api.messages.branchChat);

  const handleBranchMessage = async (messageId: string) => {
    try {
      const newChatId = await branchChatMutation({ messageId });
      // Navigate to the new chat
      window.location.href = `/c/${newChatId}`;
    } catch (error) {
      console.error("Failed to branch chat:", error);
      throw error;
    }
  };

  const displayMessages = triggerRun
    ? [
        ...triggerBaseAndUserMessages,
        ...(triggerAssistantMessage ? [triggerAssistantMessage] : []),
      ]
    : messages;
  const displayStatus = triggerRun ? triggerStatus : status;
  const hasMessages = displayMessages.length > 0;
  const showChatLayout = hasMessages || isExistingChat;

  // UI-level temporary chat flag
  const isTempChat = !isExistingChat && temporaryChatsEnabled;

  // Get branched chat info directly from chatData (no additional query needed)
  const branchedFromChatId = chatData?.branched_from_chat_id;
  const branchedFromChatTitle = (chatData as any)?.branched_from_title;

  // Check if we tried to load an existing chat but it doesn't exist or doesn't belong to user
  const isChatNotFound =
    isExistingChat &&
    chatData === null &&
    shouldFetchMessages &&
    !awaitingServerChat;

  return (
    <ConvexErrorBoundary>
      <div className="h-full bg-background flex flex-col overflow-hidden">
        <div className="flex w-full h-full overflow-hidden">
          {/* Chat Sidebar - Desktop screens: always mounted, collapses to icon rail when closed */}
          {!isMobile && (
            <div
              data-testid="sidebar"
              className={`transition-all duration-300 ${
                chatSidebarOpen ? "w-72 flex-shrink-0" : "w-12 flex-shrink-0"
              }`}
            >
              <SidebarProvider
                open={chatSidebarOpen}
                onOpenChange={setChatSidebarOpen}
                defaultOpen={true}
              >
                <MainSidebar />
              </SidebarProvider>
            </div>
          )}

          {/* Main Content Area */}
          <div className="flex flex-1 min-w-0 relative">
            {/* Left side - Chat content */}
            <div className="flex flex-col flex-1 min-w-0">
              {/* Unified Header */}
              <ChatHeader
                hasMessages={hasMessages}
                hasActiveChat={isExistingChat}
                chatTitle={chatTitle}
                id={routeChatId}
                chatData={chatData}
                chatSidebarOpen={chatSidebarOpen}
                isExistingChat={isExistingChat}
                isChatNotFound={isChatNotFound}
                branchedFromChatTitle={branchedFromChatTitle}
              />

              {/* Chat interface */}
              <div className="bg-background flex flex-col flex-1 relative min-h-0">
                {/* Messages area */}
                {isChatNotFound ? (
                  <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                    <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                      <div className="text-center">
                        <h1 className="text-2xl font-bold text-foreground mb-2">
                          Chat Not Found
                        </h1>
                        <p className="text-muted-foreground">
                          This chat doesn&apos;t exist or you don&apos;t have
                          permission to view it.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : showChatLayout ? (
                  <Messages
                    scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
                    contentRef={contentRef as RefObject<HTMLDivElement | null>}
                    messages={displayMessages}
                    setMessages={setMessages}
                    onRegenerate={handleRegenerate}
                    onRetry={handleRetry}
                    onEditMessage={handleEditMessage}
                    onBranchMessage={handleBranchMessage}
                    status={displayStatus}
                    error={error || null}
                    paginationStatus={paginatedMessages.status}
                    loadMore={paginatedMessages.loadMore}
                    isSwitchingChats={false}
                    isTemporaryChat={isTempChat}
                    tempChatFileDetails={tempChatFileDetails}
                    finishReason={chatData?.finish_reason}
                    uploadStatus={uploadStatus}
                    summarizationStatus={summarizationStatus}
                    mode={chatMode ?? (chatData as any)?.default_model_slug}
                    chatTitle={chatTitle}
                    branchedFromChatId={branchedFromChatId}
                    branchedFromChatTitle={branchedFromChatTitle}
                  />
                ) : (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
                      <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
                        <div className="text-center">
                          {temporaryChatsEnabled ? (
                            <>
                              <h1 className="text-3xl font-bold text-foreground mb-2">
                                Temporary Chat
                              </h1>
                              <p className="text-muted-foreground max-w-md mx-auto px-4 py-3">
                                This chat won&apos;t appear in history, use or
                                update HackerAI&apos;s memory, or be used to
                                train models. This chat will be deleted when you
                                refresh the page.
                              </p>
                            </>
                          ) : (
                            <>
                              <h1 className="text-3xl font-bold text-foreground mb-2">
                                HackerAI
                              </h1>
                              <p className="text-muted-foreground">
                                Your AI pentest assistant
                              </p>
                            </>
                          )}
                        </div>

                        {/* Centered input (desktop only) */}
                        {!isMobile && (
                          <div className="w-full">
                            <ChatInput
                              onSubmit={handleSubmit}
                              onStop={handleStop}
                              onSendNow={handleSendNow}
                              status={displayStatus}
                              isCentered={true}
                              hasMessages={hasMessages}
                              isAtBottom={isAtBottom}
                              onScrollToBottom={handleScrollToBottom}
                              isNewChat={!isExistingChat}
                              chatId={chatId}
                              rateLimitWarning={
                                rateLimitWarning ? rateLimitWarning : undefined
                              }
                              onDismissRateLimitWarning={
                                handleDismissRateLimitWarning
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Footer - only show when user is not logged in */}
                    <div className="flex-shrink-0">
                      <Footer />
                    </div>
                  </div>
                )}

                {/* Chat Input - Bottom placement (also for mobile new chats) */}
                {(hasMessages || isExistingChat || isMobile) &&
                  !isChatNotFound && (
                    <ChatInput
                      onSubmit={handleSubmit}
                      onStop={handleStop}
                      onSendNow={handleSendNow}
                      status={displayStatus}
                      hasMessages={hasMessages}
                      isAtBottom={isAtBottom}
                      onScrollToBottom={handleScrollToBottom}
                      isNewChat={!isExistingChat}
                      chatId={chatId}
                      rateLimitWarning={
                        rateLimitWarning ? rateLimitWarning : undefined
                      }
                      onDismissRateLimitWarning={handleDismissRateLimitWarning}
                    />
                  )}
              </div>
            </div>

            {/* Desktop Computer Sidebar */}
            {!isMobile && (
              <div
                className={`transition-all duration-300 min-w-0 ${
                  sidebarOpen ? "w-1/2 flex-shrink-0" : "w-0 overflow-hidden"
                }`}
              >
                {sidebarOpen && (
                  <ComputerSidebar
                    messages={displayMessages}
                    status={displayStatus}
                  />
                )}
              </div>
            )}

            {/* Drag and Drop Overlay - covers main content area only (excludes sidebars) */}
            <DragDropOverlay
              isVisible={showDragOverlay}
              isDragOver={isDragOver}
            />
          </div>
        </div>

        {/* Mobile Computer Sidebar */}
        {isMobile && sidebarOpen && (
          <div className="flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
            <div className="w-full max-w-4xl h-full">
              <ComputerSidebar
                messages={displayMessages}
                status={displayStatus}
              />
            </div>
          </div>
        )}

        {/* Overlay Chat Sidebar - Mobile screens */}
        {isMobile && chatSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 flex"
            onClick={() => setChatSidebarOpen(false)}
          >
            <div
              className="w-full max-w-80 h-full bg-background shadow-lg transform transition-transform duration-300 ease-in-out"
              onClick={(e) => e.stopPropagation()}
            >
              <MainSidebar isMobileOverlay={true} />
            </div>
            {/* Clickable area to close sidebar */}
            <div className="flex-1" />
          </div>
        )}
      </div>
    </ConvexErrorBoundary>
  );
};
