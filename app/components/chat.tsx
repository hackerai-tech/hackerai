"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type RefObject,
} from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FileDetails } from "@/types/file";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import type { RateLimitWarningData } from "./RateLimitWarning";
import { ComputerSidebar } from "./ComputerSidebar";
import ChatHeader from "./ChatHeader";
import Footer from "./Footer";
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
import type { Todo, ChatMessage, ChatMode } from "@/types";
// import { isSelectedModel } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";
import type { ContextUsageData } from "./ContextUsageIndicator";
import { shouldTreatAsMerge } from "@/lib/utils/todo-utils";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { useParams, useRouter } from "next/navigation";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";
import { useAutoResume } from "../hooks/useAutoResume";
import { useAutoContinue } from "../hooks/useAutoContinue";
import { useLatestRef } from "../hooks/useLatestRef";
import { useDataStream } from "./DataStreamProvider";
import { removeDraft } from "@/lib/utils/client-storage";
import { parseRateLimitWarning } from "@/lib/utils/parse-rate-limit-warning";
import Loading from "@/components/ui/loading";

export const Chat = ({ autoResume }: { autoResume: boolean }) => {
  const params = useParams();
  const routeChatId = params?.id as string | undefined;
  const router = useRouter();
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
    chatMode,
    setChatMode,
    sidebarOpen,
    chatSidebarOpen,
    setChatSidebarOpen,
    initializeChat,
    mergeTodos,
    setTodos,
    replaceAssistantTodos,
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
    tauriCmdServer,
    selectedModel,
    // setSelectedModel,
  } = useGlobalState();

  // Simple logic: use route chatId if provided, otherwise generate new one
  const [chatId, setChatId] = useState<string>(() => {
    return routeChatId || uuidv4();
  });

  // Track whether this is an existing chat (prop-driven initially, flips after first completion)
  const [isExistingChat, setIsExistingChat] = useState<boolean>(!!routeChatId);
  const wasNewChatRef = useRef(!routeChatId);
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

  // Context usage tracking (populated by server via data stream on each generation)
  const [contextUsage, setContextUsage] = useState<ContextUsageData>({
    messagesTokens: 0,
    summaryTokens: 0,
    systemTokens: 0,
    maxTokens: 0,
  });

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
  // Track whether sandbox preference has been initialized from chat for this chat id
  const hasInitializedSandboxRef = useRef(false);
  // Track whether the stored sandbox connection was validated (stale connections unlock the selector)
  // TODO: restore when model selector is re-enabled
  // const hasInitializedModelRef = useRef(false);

  // Sync local chat state from URL (single source of truth)
  useEffect(() => {
    if (routeChatId) {
      setChatId(routeChatId);
      setIsExistingChat(true);
    } else {
      // Navigated to "/" (new chat) — reset to fresh state
      setChatId(uuidv4());
      setIsExistingChat(false);
      wasNewChatRef.current = true;
    }
  }, [routeChatId]);

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

  // Query local sandbox connections only when we need to validate a non-E2B sandbox_type
  const storedSandboxType = (chatData as any)?.sandbox_type as
    | string
    | undefined;
  const needsConnectionValidation =
    !!storedSandboxType &&
    storedSandboxType !== "e2b" &&
    storedSandboxType !== "tauri" &&
    !hasInitializedSandboxRef.current;
  const localConnections = useQuery(
    api.localSandbox.listConnections,
    needsConnectionValidation ? undefined : "skip",
  );

  // Derive title from Convex (single source of truth)
  const chatTitle = chatData?.title ?? null;

  // Convert paginated Convex messages to UI format for useChat and useAutoResume
  // Messages come from server in descending order (newest first from pagination); reverse for chronological order
  const serverMessages: ChatMessage[] =
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
    messages: serverMessages,
    experimental_throttle: 100,
    generateId: () => uuidv4(),

    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
        // Dynamically route to correct API based on current mode
        const url =
          input === "/api/chat" && chatModeRef.current === "agent"
            ? "/api/agent"
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
        const rawData = dataPart.data as Record<string, unknown>;
        const parsed = parseRateLimitWarning(rawData, {
          hasUserDismissed: hasUserDismissedWarningRef.current,
        });
        if (parsed) setRateLimitWarning(parsed);
      }
      if (dataPart.type === "data-file-metadata") {
        const fileData = dataPart.data as {
          messageId: string;
          fileDetails: FileDetails[];
        };

        // Merge into parallel state (outside AI SDK control)
        // Uses merge-with-dedup so incremental events (per-file) and
        // the onFinish batch event both work without duplicates
        setTempChatFileDetails((prev) => {
          const next = new Map(prev);
          const existing = next.get(fileData.messageId) || [];
          const existingIds = new Set(
            existing.map((f: FileDetails) => f.fileId),
          );
          const newFiles = fileData.fileDetails.filter(
            (f: FileDetails) => !existingIds.has(f.fileId),
          );
          next.set(fileData.messageId, [...existing, ...newFiles]);
          return next;
        });
      }
      if (dataPart.type === "data-context-usage") {
        const usage = dataPart.data as ContextUsageData;
        setContextUsage(usage);
      }
      if (dataPart.type === "data-sandbox-fallback") {
        const fallbackData = dataPart.data as {
          occurred: boolean;
          reason: "connection_unavailable" | "no_local_connections";
          requestedPreference: string;
          actualSandbox: string;
          actualSandboxName?: string;
        };

        // Skip fallback notifications for Tauri — the server-side health check
        // hits its own localhost, not the user's desktop, so it consistently
        // reports false disconnects. The frontend already validated Tauri availability.
        if (fallbackData.requestedPreference === "tauri") {
          return;
        }

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
      const isTemporaryChat =
        !isExistingChatRef.current && temporaryChatsEnabledRef.current;
      if (!isExistingChatRef.current && !isTemporaryChat) {
        // Update URL without full navigation so this Chat stays mounted and
        // status can transition to "ready" (stop button → send button).
        window.history.replaceState({}, "", `/c/${chatId}`);
        removeDraft("new");
        setIsExistingChat(true);
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

  // Ref (not state) so the Convex sync effect only fires when paginatedMessages.results
  // changes, not on status transitions — avoiding the stale-data overwrite on stream stop.
  const statusRef = useRef(status);
  statusRef.current = status;

  // Auto-resume: reconnect to resumable stream on refresh (e.g. /api/chat/[id]/stream)
  useAutoResume({
    autoResume,
    initialMessages: serverMessages,
    resumeStream,
    setMessages,
  });

  const { resetAutoContinueCount } = useAutoContinue({
    status,
    chatMode,
    sendMessage,
    hasManuallyStoppedRef,
    todos,
    temporaryChatsEnabled,
    sandboxPreference,
    selectedModel,
  });

  // Register a reset function with global state so initializeNewChat can call it
  useEffect(() => {
    const reset = () => {
      setMessages([]);
      setChatId(uuidv4());
      setIsExistingChat(false);
      wasNewChatRef.current = true;
      setTodos([]);
      setAwaitingServerChat(false);
      setUploadStatus(null);
      setSummarizationStatus(null);
      setContextUsage({
        messagesTokens: 0,
        summaryTokens: 0,
        systemTokens: 0,
        maxTokens: 0,
      });
      resetAutoContinueCount();
    };
    setChatReset(reset);
    return () => setChatReset(null);
  }, [setChatReset, setMessages, setTodos, resetAutoContinueCount]);

  // Reset the one-time initializer when chat changes (must come before chatData effect to handle cached data)
  useEffect(() => {
    hasInitializedModeFromChatRef.current = false;
    hasInitializedSandboxRef.current = false;
    // hasInitializedModelRef.current = false;
  }, [chatId]);

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
    } else {
      setTodos([]);
    }
    // Server has responded for this chat id; stop suppressing not-found state
    setAwaitingServerChat(false);
    // Initialize mode from server once per chat id (only for existing chats)
    if (!hasInitializedModeFromChatRef.current && isExistingChat) {
      hasInitializedModeFromChatRef.current = true;
      // For older chats without default_model_slug, detect agent-long by presence of active_trigger_run_id (legacy DB)
      const slug =
        (chatData as any).default_model_slug ||
        ((chatData as any).active_trigger_run_id ? "agent-long" : undefined);
      if (slug === "ask" || slug === "agent" || slug === "agent-long") {
        setChatMode(slug === "agent-long" ? "agent" : slug);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatData, setTodos, shouldFetchMessages, isExistingChat, chatId]);

  // Initialize sandbox preference from chat data, validated against available connections.
  // Separate from the main chatData effect so it can re-run when localConnections loads.
  useEffect(() => {
    if (hasInitializedSandboxRef.current || !isExistingChat) return;

    const dataId = (chatData as any)?.id as string | undefined;
    if (!chatData || dataId !== chatId) return;

    if (!storedSandboxType) {
      if (wasNewChatRef.current) {
        // Chat was just created — keep the user's current sandboxPreference
        // (it was already sent in the request body). Don't reset to cloud.
      } else {
        // Navigated to an existing chat with no stored sandbox type — reset to cloud
        // so a stale local preference from a previous chat doesn't persist.
        setSandboxPreference("e2b");
      }
      hasInitializedSandboxRef.current = true;
      return;
    }

    if (storedSandboxType === "e2b") {
      setSandboxPreference("e2b");
      hasInitializedSandboxRef.current = true;
    } else if (storedSandboxType === "tauri") {
      // Only restore "tauri" if the desktop bridge is actually available.
      // If tauriCmdServer is still undefined (bridge discovery in progress),
      // defer — the effect will re-run when tauriCmdServer resolves.
      if (tauriCmdServer === undefined) return;
      setSandboxPreference(tauriCmdServer ? "tauri" : "e2b");
      hasInitializedSandboxRef.current = true;
    } else if (localConnections !== undefined) {
      // For local connectionIds, validate the connection still exists
      const connectionExists = localConnections.some(
        (conn) => conn.connectionId === storedSandboxType,
      );
      if (connectionExists) {
        setSandboxPreference(storedSandboxType);
      } else {
        // Stale connection — fall back to cloud
        setSandboxPreference("e2b");
      }
      hasInitializedSandboxRef.current = true;
    }
    // If localConnections is still loading (undefined), wait for next render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatData, localConnections, isExistingChat, chatId, tauriCmdServer]);

  // TODO: restore when model selector is re-enabled
  // Initialize model selection from chat data
  // useEffect(() => {
  //   if (hasInitializedModelRef.current || !isExistingChat) return;
  //   const dataId = (chatData as any)?.id as string | undefined;
  //   if (!chatData || dataId !== chatId) return;
  //   const savedModel = (chatData as any).selected_model as string | undefined;
  //   hasInitializedModelRef.current = true;
  //   if (savedModel && isSelectedModel(savedModel)) {
  //     setSelectedModel(savedModel);
  //   }
  // }, [chatData, isExistingChat, chatId]);

  // Sync Convex real-time data with useChat messages.
  // Uses statusRef (not status state) so this effect only fires when
  // paginatedMessages.results actually changes — not on status transitions.
  // Guards against BOTH "streaming" and "submitted" statuses to prevent
  // Convex real-time updates from overwriting useChat's in-flight state.
  // Without the "submitted" guard, a race condition occurs in production:
  // Convex receives the user message (via handleInitialChatAndUserMessage)
  // and pushes a subscription update before the first streaming chunk arrives,
  // resetting useChat's messages and causing an empty AI response.
  useEffect(() => {
    if (
      statusRef.current === "streaming" ||
      statusRef.current === "submitted"
    ) {
      return;
    }
    if (!paginatedMessages.results || paginatedMessages.results.length === 0) {
      return;
    }

    const uiMessages = convertToUIMessages(
      [...paginatedMessages.results].reverse(),
    );

    if (isExistingChat) {
      setMessages(uiMessages);
    }
  }, [paginatedMessages.results, setMessages, isExistingChat, chatId]);

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

  // Handle instant scroll to bottom when first loading existing chat messages.
  // Only runs once per chat — pagination (which prepends older messages and
  // increases messages.length) must NOT re-trigger this.
  const hasScrolledToBottomRef = useRef(false);
  useEffect(() => {
    hasScrolledToBottomRef.current = false;
  }, [chatId]);
  useEffect(() => {
    if (
      isExistingChat &&
      messages.length > 0 &&
      !hasScrolledToBottomRef.current
    ) {
      hasScrolledToBottomRef.current = true;
      scrollToBottom({ instant: true, force: true });
    }
  }, [messages.length, scrollToBottom, isExistingChat]);

  const displayStatusForQueue = status;

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

  // Automatic queue processing - send next queued message when ready
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
        sendMessage(
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
    sendMessage,
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
    messages,
    sendMessage,
    stop,
    regenerate,
    setMessages,
    isExistingChat,
    status,
    isSendingNowRef,
    hasManuallyStoppedRef,
    onStopCallback: () => {
      setUploadStatus(null);
      setSummarizationStatus(null);
    },
    resetAutoContinueCount,
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
      initializeChat(newChatId);
      router.push(`/c/${newChatId}`);
    } catch (error) {
      console.error("Failed to branch chat:", error);
      throw error;
    }
  };

  const displayMessages = messages;
  const displayStatus = status;
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
      <div className="flex min-h-0 flex-1 w-full flex-col bg-background overflow-hidden">
        <div className="flex min-h-0 flex-1 min-w-0 relative">
          {/* Left side - Chat content */}
          <div className="flex min-h-0 flex-col flex-1 min-w-0">
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
              ) : isExistingChat &&
                paginatedMessages.status === "LoadingFirstPage" &&
                !hasMessages ? (
                <div
                  className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center min-h-0"
                  data-testid="messages-loading"
                >
                  <Loading size={10} />
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
                              update HackerAI&apos;s memory, or be used to train
                              models. This chat will be deleted when you refresh
                              the page.
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
                            contextUsage={contextUsage}
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
                    contextUsage={contextUsage}
                  />
                )}
            </div>
          </div>

          {/* Desktop Computer Sidebar */}
          {!isMobile && (
            <div
              className={`transition-[width] duration-300 min-w-0 ${
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
      </div>
    </ConvexErrorBoundary>
  );
};
