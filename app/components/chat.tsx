"use client";

import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  useRef,
  useEffect,
  useState,
  useReducer,
  useMemo,
  useCallback,
  type RefObject,
} from "react";
import { useQuery, usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FileDetails } from "@/types/file";
import { CodexLocalTransport } from "@/lib/local-providers/codex-transport";
import { DelegatingTransport } from "@/lib/local-providers/delegating-transport";
import { useCodexSidecar } from "@/app/hooks/useCodexLocal";
import { useCodexPersistence } from "@/app/hooks/useCodexPersistence";
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
import {
  normalizeMessages,
  sanitizeCodexToolCalls,
} from "@/lib/utils/message-processor";
import { ChatSDKError } from "@/lib/errors";
import { fetchWithErrorHandlers, convertToUIMessages } from "@/lib/utils";
import { toast } from "sonner";
import type { Todo, ChatMessage, ChatMode } from "@/types";
import { isCodexLocal, getCodexSubModel, isSelectedModel } from "@/types/chat";
import { serializeConversation } from "@/lib/utils/conversation-serializer";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import type { ContextUsageData } from "./ContextUsageIndicator";
import { shouldTreatAsMerge } from "@/lib/utils/todo-utils";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { useParams, useRouter } from "next/navigation";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";
import { useAutoResume } from "../hooks/useAutoResume";
import { useAutoContinue } from "../hooks/useAutoContinue";
import {
  useStreamReconnect,
  isNetworkStreamError,
} from "../hooks/useStreamReconnect";
import { useLatestRef } from "../hooks/useLatestRef";
import {
  getCmdServerInfo,
  setConvexAuth,
  isTauriEnvironment,
} from "../hooks/useTauri";
import { useAuth, useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { useDataStreamDispatch } from "./DataStreamProvider";
import { removeDraft } from "@/lib/utils/client-storage";
import { parseRateLimitWarning } from "@/lib/utils/parse-rate-limit-warning";
import Loading from "@/components/ui/loading";

import { HackingSuggestions } from "./HackingSuggestions";

// --- Streaming ephemeral state reducer ---
// Consolidates high-frequency streaming state updates into a single dispatch
// to avoid cascading re-renders from multiple independent useState calls.
interface StreamingEphemeralState {
  uploadStatus: { message: string; isUploading: boolean } | null;
  summarizationStatus: {
    status: "started" | "completed";
    message: string;
  } | null;
  rateLimitWarning: RateLimitWarningData | null;
  contextUsage: ContextUsageData;
}

type StreamingAction =
  | {
      type: "SET_UPLOAD_STATUS";
      payload: StreamingEphemeralState["uploadStatus"];
    }
  | {
      type: "SET_SUMMARIZATION_STATUS";
      payload: StreamingEphemeralState["summarizationStatus"];
    }
  | {
      type: "SET_RATE_LIMIT_WARNING";
      payload: StreamingEphemeralState["rateLimitWarning"];
    }
  | { type: "SET_CONTEXT_USAGE"; payload: ContextUsageData }
  | { type: "RESET_ON_FINISH" };

const initialStreamingState: StreamingEphemeralState = {
  uploadStatus: null,
  summarizationStatus: null,
  rateLimitWarning: null,
  contextUsage: { usedTokens: 0, maxTokens: 0 },
};

function streamingReducer(
  state: StreamingEphemeralState,
  action: StreamingAction,
): StreamingEphemeralState {
  switch (action.type) {
    case "SET_UPLOAD_STATUS":
      if (state.uploadStatus === action.payload) return state;
      return { ...state, uploadStatus: action.payload };
    case "SET_SUMMARIZATION_STATUS":
      if (state.summarizationStatus === action.payload) return state;
      return { ...state, summarizationStatus: action.payload };
    case "SET_RATE_LIMIT_WARNING":
      return { ...state, rateLimitWarning: action.payload };
    case "SET_CONTEXT_USAGE":
      return { ...state, contextUsage: action.payload };
    case "RESET_ON_FINISH":
      if (state.uploadStatus === null && state.summarizationStatus === null)
        return state;
      return {
        ...state,
        uploadStatus: null,
        summarizationStatus: null,
      };
    default:
      return state;
  }
}

// Renderless component that isolates dataStream state subscriptions
// (useAutoResume + useAutoContinue) from the Chat component.
// Without this boundary, Chat subscribes to DataStreamStateContext
// through these hooks and re-renders on every stream chunk.
function StreamEffects({
  autoResume,
  serverMessages,
  resumeStream,
  setMessages,
  status,
  chatMode,
  sendMessage,
  hasManuallyStoppedRef,
  todos,
  temporaryChatsEnabled,
  sandboxPreference,
  selectedModel,
  resetRef,
}: {
  autoResume: boolean;
  serverMessages: ChatMessage[];
  resumeStream: UseChatHelpers<ChatMessage>["resumeStream"];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
  chatMode: string;
  sendMessage: (
    message: { text: string } | any,
    options?: { body?: Record<string, unknown> },
  ) => void;
  hasManuallyStoppedRef: RefObject<boolean>;
  todos: Todo[];
  temporaryChatsEnabled: boolean;
  sandboxPreference: string;
  selectedModel: string;
  resetRef: RefObject<(() => void) | null>;
}) {
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

  // Expose resetAutoContinueCount to parent via ref (avoids state coupling)
  useEffect(() => {
    resetRef.current = resetAutoContinueCount;
  }, [resetRef, resetAutoContinueCount]);

  return null;
}

export const Chat = ({ autoResume }: { autoResume: boolean }) => {
  const params = useParams();
  const routeChatId = params?.id as string | undefined;
  const router = useRouter();
  const isMobile = useIsMobile();
  const { setDataStream, setIsAutoResuming } = useDataStreamDispatch();
  const [streamingState, dispatchStreaming] = useReducer(
    streamingReducer,
    initialStreamingState,
  );
  const { uploadStatus, summarizationStatus, rateLimitWarning, contextUsage } =
    streamingState;

  const {
    input,
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
    selectedModel,
    setSelectedModel,
    subscription,
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
  const hasInitializedModelRef = useRef(false);

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
  // Track current message IDs so the Convex sync effect can skip redundant
  // setMessages calls (e.g. after local provider saves echo back the same data).
  const messagesRef = useRef<ChatMessage[]>([]);
  // Suppress Convex sync briefly after Codex stream finishes to prevent
  // the echo-back from replacing in-memory messages (causes flicker/scroll jump).
  const codexSyncSuppressedUntilRef = useRef(0);

  // Ref for selected model so the delegating transport reads latest value
  const selectedModelRef = useLatestRef(selectedModel);
  // Ref for subscription so the delegating transport reads latest value
  const subscriptionRef = useLatestRef(subscription);
  // Ref for chatId so the delegating transport reads latest value
  const chatIdRef = useLatestRef(chatId);

  // Convex queries for local provider prompt data (only fetched when in Tauri desktop)
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );
  const userNotes = useQuery(api.notes.getUserNotes, {});
  const userCustomizationRef = useLatestRef(userCustomization);
  const userNotesRef = useLatestRef(userNotes);

  // Cmd server info for notes API (fetched once in Tauri environment)
  const cmdServerInfoRef = useRef<{ port: number; token: string } | null>(null);
  const { user: authUser } = useAuth();
  const { getAccessToken } = useAccessToken();
  useEffect(() => {
    if (isTauriEnvironment()) {
      getCmdServerInfo()
        .then((info) => {
          cmdServerInfoRef.current = info;
        })
        .catch((err) => {
          console.error("[Tauri] Failed to get cmd server info:", err);
        });
    }
  }, []);

  // Sync Convex auth token + notes setting to Tauri backend for notes API
  const notesEnabled = userCustomization?.include_memory_entries ?? true;
  const lastSyncedTokenRef = useRef<string | null>(null);
  const lastSyncedNotesEnabledRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isTauriEnvironment() || !authUser?.id) return;
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) return;

    const syncToken = async () => {
      try {
        const token = await getAccessToken();
        if (
          token &&
          (token !== lastSyncedTokenRef.current ||
            notesEnabled !== lastSyncedNotesEnabledRef.current)
        ) {
          await setConvexAuth(convexUrl, token, notesEnabled);
          lastSyncedTokenRef.current = token;
          lastSyncedNotesEnabledRef.current = notesEnabled;
        }
      } catch (err) {
        console.error("[Tauri] Failed to sync Convex auth:", err);
      }
    };

    syncToken();
    // Check token freshness every 30s but only sync if changed
    const interval = setInterval(syncToken, 30_000);
    return () => clearInterval(interval);
  }, [authUser?.id, getAccessToken, notesEnabled]);

  // Stable transport instances
  const codexTransport = useMemo(() => new CodexLocalTransport(), []);

  // Manage the Codex SDK sidecar process — starts on demand when Codex is selected
  const { ensureSidecar } = useCodexSidecar(codexTransport);
  const ensureSidecarRef = useLatestRef(ensureSidecar);

  // Local provider message persistence
  const { persistCodexMessages } = useCodexPersistence({
    chatId,
    codexTransport,
    selectedModelRef,
    isExistingChatRef,
    setIsExistingChat,
  });

  // Delegating transport that switches between Codex local and default based on selected model
  // beforeSend ensures the sidecar is running when Codex is selected
  const transport = useMemo(
    () =>
      new DelegatingTransport(
        () => {
          if (isCodexLocal(selectedModelRef.current)) {
            return codexTransport;
          }
          return defaultTransportRef.current;
        },
        async () => {
          if (isCodexLocal(selectedModelRef.current)) {
            const subModel = getCodexSubModel(selectedModelRef.current || "");
            codexTransport.setModel(subModel);
            const includeNotes =
              userCustomizationRef.current?.include_memory_entries ?? true;
            codexTransport.setUserData({
              userCustomization: userCustomizationRef.current,
              notes: includeNotes
                ? (userNotesRef.current ?? undefined)
                : undefined,
              model: subModel,
              cmdServerPort: cmdServerInfoRef.current?.port,
              cmdServerToken: cmdServerInfoRef.current?.token,
            });

            // Detect server→codex switch: existing messages but no codex thread
            const currentMessages = messagesRef.current;
            const currentChatId = chatIdRef.current;
            if (
              currentMessages.length > 0 &&
              !codexTransport.getThreadId(currentChatId)
            ) {
              const maxTokens = getMaxTokensForSubscription(
                subscriptionRef.current,
                {
                  maxMode:
                    userCustomizationRef.current?.max_mode_enabled ?? false,
                  modelName: selectedModelRef.current ?? undefined,
                  mode: chatModeRef.current as "ask" | "agent",
                },
              );
              const context = serializeConversation(currentMessages, maxTokens);
              if (context) {
                codexTransport.setConversationContext(currentChatId, context);
              }
            }

            const sidecarOk = await ensureSidecarRef.current();
            if (!sidecarOk) {
              toast.error("This chat requires the desktop app", {
                description:
                  "Codex models run locally and need the HackerAI desktop app.",
              });
              return false;
            }
          }
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [codexTransport],
  );

  // Ref for setMessages — needed by DefaultChatTransport which is created before useChat returns
  const setMessagesRef = useRef<(messages: any[]) => void>(() => {});

  // Ref bridge — onData fires inside useChat callbacks, but resetReconnect
  // comes from useStreamReconnect which must be constructed after useChat.
  const resetReconnectRef = useRef<() => void>(() => {});

  // Default transport (OpenRouter) - stored in ref since it's created before useChat
  const defaultTransportRef = useRef(
    new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
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
          setMessagesRef.current(normalizedMessages);
        }

        const isTemporaryChat =
          !isExistingChatRef.current && temporaryChatsEnabledRef.current;

        const stripUrlsFromMessages = (msgs: ChatMessage[]): ChatMessage[] => {
          return msgs.map((msg) => {
            if (!msg.parts || msg.parts.length === 0) return msg;
            const strippedParts = msg.parts.map((part: any) => {
              if (part.type === "file" && "url" in part) {
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
        // Convert codex-specific tool parts to text so server models understand them
        const sanitizedMessages = sanitizeCodexToolCalls(messagesToSend);
        const messagesWithoutUrls = stripUrlsFromMessages(sanitizedMessages);

        return {
          body: {
            chatId: id,
            messages: messagesWithoutUrls,
            ...body,
          },
        };
      },
    }),
  );

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
    experimental_throttle: 150,
    generateId: () => uuidv4(),

    transport,

    onData: (dataPart) => {
      // Any server-sent data part means the stream is healthy again.
      resetReconnectRef.current();
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
      switch (dataPart.type) {
        case "data-upload-status": {
          const uploadData = dataPart.data as {
            message: string;
            isUploading: boolean;
          };
          dispatchStreaming({
            type: "SET_UPLOAD_STATUS",
            payload: uploadData.isUploading ? uploadData : null,
          });
          break;
        }
        case "data-summarization": {
          const summaryData = dataPart.data as {
            status: "started" | "completed";
            message: string;
          };
          dispatchStreaming({
            type: "SET_SUMMARIZATION_STATUS",
            payload: summaryData.status === "started" ? summaryData : null,
          });
          break;
        }
        case "data-rate-limit-warning": {
          const rawData = dataPart.data as Record<string, unknown>;
          const parsed = parseRateLimitWarning(rawData, {
            hasUserDismissed: hasUserDismissedWarningRef.current,
          });
          if (parsed) {
            dispatchStreaming({
              type: "SET_RATE_LIMIT_WARNING",
              payload: parsed,
            });
          }
          break;
        }
        case "data-file-metadata": {
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
          break;
        }
        case "data-context-usage": {
          const usage = dataPart.data as ContextUsageData;
          dispatchStreaming({ type: "SET_CONTEXT_USAGE", payload: usage });
          break;
        }
        case "data-sandbox-fallback": {
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
            break;
          }

          // Update sandbox preference to match actual sandbox used
          setSandboxPreference(fallbackData.actualSandbox);

          // Show toast notification
          const message =
            fallbackData.reason === "no_local_connections"
              ? `Local sandbox unavailable. Using ${fallbackData.actualSandboxName || "Cloud"}.`
              : `Selected sandbox disconnected. Switched to ${fallbackData.actualSandboxName || "Cloud"}.`;
          toast.info(message, { duration: 5000 });
          break;
        }
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
      dispatchStreaming({ type: "RESET_ON_FINISH" });

      // Local providers: persist messages + thread to Convex.
      // Suppress Convex sync for 2s so the echo-back doesn't replace
      // in-memory messages with fresh objects (causes flicker/scroll jump).
      if (isCodexLocal(selectedModelRef.current)) {
        codexSyncSuppressedUntilRef.current = Date.now() + 2000;
        persistCodexMessages(messages);
        return;
      }

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
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });

      // Network errors are handled by the auto-reconnect effect below —
      // suppress the toast and keep the spinner via isAutoResuming flow.
      if (isNetworkStreamError(error)) return;

      setIsAutoResuming(false);
      if (error instanceof ChatSDKError && error.type !== "rate_limit") {
        toast.error(error.message);
      }
    },
  });

  const {
    isReconnecting,
    exhausted: reconnectExhausted,
    tryReconnect,
    reset: resetReconnect,
  } = useStreamReconnect({ resumeStream });
  resetReconnectRef.current = resetReconnect;

  // Auto-reconnect on network errors. Each failed attempt produces a new
  // `error` identity, so this effect re-fires through the retry sequence
  // until success (error clears) or exhaustion (tryReconnect returns false).
  useEffect(() => {
    if (status !== "error" || !error) return;
    if (!isNetworkStreamError(error)) return;
    // Skip paths that don't support resumable server streams.
    const isTempChat =
      !isExistingChatRef.current && temporaryChatsEnabledRef.current;
    if (isCodexLocal(selectedModelRef.current) || isTempChat) return;
    tryReconnect();
  }, [status, error, tryReconnect]);

  // Wrap send/regenerate so a new user action cancels any pending reconnect.
  const sendMessageWithReset: typeof sendMessage = useCallback(
    (...args) => {
      resetReconnect();
      return sendMessage(...args);
    },
    [sendMessage, resetReconnect],
  );
  const regenerateWithReset: typeof regenerate = useCallback(
    (...args) => {
      resetReconnect();
      return regenerate(...args);
    },
    [regenerate, resetReconnect],
  );

  // Keep refs in sync so closures read latest values
  setMessagesRef.current = setMessages;
  messagesRef.current = messages;

  // Ref (not state) so the Convex sync effect only fires when paginatedMessages.results
  // changes, not on status transitions — avoiding the stale-data overwrite on stream stop.
  const statusRef = useRef(status);
  statusRef.current = status;

  // Ref bridge: StreamEffects exposes resetAutoContinueCount here
  const resetAutoContinueRef = useRef<(() => void) | null>(null);
  const resetAutoContinueCount = useCallback(() => {
    resetAutoContinueRef.current?.();
  }, []);

  // Register a reset function with global state so initializeNewChat can call it
  useEffect(() => {
    const reset = () => {
      setMessages([]);
      setChatId(uuidv4());
      setIsExistingChat(false);
      wasNewChatRef.current = true;
      setTodos([]);
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });
      dispatchStreaming({
        type: "SET_CONTEXT_USAGE",
        payload: { usedTokens: 0, maxTokens: 0 },
      });
      // Clear DataStreamProvider state so stale parts from the previous chat
      // don't feed into useAutoResume/useAutoContinue in the next conversation.
      setDataStream([]);
      setIsAutoResuming(false);
      setHasUserDismissedRateLimitWarning(false);
      resetAutoContinueCount();
    };
    setChatReset(reset);
    return () => setChatReset(null);
  }, [setChatReset, setMessages, setTodos, resetAutoContinueCount]);

  // Reset the one-time initializer when chat changes (must come before chatData effect to handle cached data)
  useEffect(() => {
    hasInitializedModeFromChatRef.current = false;
    hasInitializedSandboxRef.current = false;
    hasInitializedModelRef.current = false;
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

    // Restore Codex thread ID from persisted chat data
    const codexThreadId = (chatData as any)?.codex_thread_id as
      | string
      | undefined;
    if (codexThreadId && codexTransport) {
      codexTransport.restoreThread(chatId, codexThreadId);
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
      const slug = (chatData as any).default_model_slug;
      if (slug === "ask" || slug === "agent") {
        setChatMode(slug);
      } else if (slug === "agent-long") {
        // Legacy chats stored as agent-long map to agent mode
        setChatMode("agent");
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
      // "tauri" is a legacy preference — desktop now uses "desktop"
      setSandboxPreference("e2b");
      hasInitializedSandboxRef.current = true;
    } else if (storedSandboxType === "desktop") {
      // Desktop preference — validate that a desktop connection exists
      if (localConnections !== undefined) {
        const desktopExists = localConnections.some((conn) => conn.isDesktop);
        setSandboxPreference(desktopExists ? "desktop" : "e2b");
        hasInitializedSandboxRef.current = true;
      }
      // If localConnections is still loading, wait for next render
    } else if (localConnections !== undefined) {
      // For remote connectionIds, validate the connection still exists
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
  }, [chatData, localConnections, isExistingChat, chatId]);

  // Initialize model selection from chat data
  useEffect(() => {
    if (hasInitializedModelRef.current || !isExistingChat) return;
    const dataId = (chatData as any)?.id as string | undefined;
    if (!chatData || dataId !== chatId) return;
    const savedModel = (chatData as any).selected_model as string | undefined;
    hasInitializedModelRef.current = true;
    if (savedModel && isSelectedModel(savedModel)) {
      setSelectedModel(savedModel);
    }
  }, [chatData, isExistingChat, chatId]);

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
    // Skip while Codex echo-back is settling to avoid flicker
    if (Date.now() < codexSyncSuppressedUntilRef.current) {
      return;
    }
    if (!paginatedMessages.results || paginatedMessages.results.length === 0) {
      return;
    }

    const uiMessages = convertToUIMessages(
      [...paginatedMessages.results].reverse(),
    );

    // Skip if useChat already has the same messages (same IDs, same part count).
    // This prevents redundant setMessages calls — e.g. after a local provider
    // save, Convex echoes the same data back via reactive query, which would
    // otherwise cause a visible flicker from new object references.
    // Comparing parts.length catches content updates where the ID stays the same.
    const current = messagesRef.current;
    if (
      current.length === uiMessages.length &&
      current.every(
        (m, i) =>
          m.id === uiMessages[i].id &&
          (m.parts?.length ?? 0) === (uiMessages[i].parts?.length ?? 0),
      )
    ) {
      return;
    }

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

  // Keep a ref to the latest messageQueue to avoid stale closures
  const messageQueueRef = useRef(messageQueue);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

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
      status === "ready" &&
      messageQueue.length > 0 &&
      !isProcessingQueue &&
      !isSendingNowRef.current &&
      !hasManuallyStoppedRef.current &&
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
    status,
    messageQueue.length,
    isProcessingQueue,
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
    sendMessage: sendMessageWithReset,
    stop,
    regenerate: regenerateWithReset,
    setMessages,
    isExistingChat,
    status,
    isSendingNowRef,
    hasManuallyStoppedRef,
    onStopCallback: () => {
      dispatchStreaming({ type: "RESET_ON_FINISH" });
    },
    resetAutoContinueCount,
  });

  const handleScrollToBottom = () => scrollToBottom({ force: true });

  // Rate limit warning dismiss handler
  const handleDismissRateLimitWarning = () => {
    dispatchStreaming({ type: "SET_RATE_LIMIT_WARNING", payload: null });
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

  // Auto-send message after forking a shared chat
  const autoSendFiredRef = useRef(false);
  useEffect(() => {
    if (autoSendFiredRef.current) return;
    try {
      const pendingChatId = sessionStorage.getItem("autoSendChatId");
      if (pendingChatId !== chatId) return;
    } catch {
      return;
    }
    // Wait for chat to be ready with draft input loaded
    if (status !== "ready" || !input.trim()) return;
    // Wait for server messages to be loaded (forked chat has messages)
    if (!isExistingChat || messages.length === 0) return;

    autoSendFiredRef.current = true;
    sessionStorage.removeItem("autoSendChatId");
    // Trigger submit with a synthetic event
    handleSubmit(new Event("submit") as unknown as React.FormEvent);
  }, [chatId, status, input, isExistingChat, messages.length, handleSubmit]);

  const hasMessages = messages.length > 0;
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
      <StreamEffects
        key={chatId}
        autoResume={autoResume}
        serverMessages={serverMessages}
        resumeStream={resumeStream}
        setMessages={setMessages}
        status={status}
        chatMode={chatMode}
        sendMessage={sendMessage}
        hasManuallyStoppedRef={hasManuallyStoppedRef}
        todos={todos}
        temporaryChatsEnabled={temporaryChatsEnabled}
        sandboxPreference={sandboxPreference}
        selectedModel={selectedModel}
        resetRef={resetAutoContinueRef}
      />
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
              ) : showChatLayout ? (
                <Messages
                  scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
                  contentRef={contentRef as RefObject<HTMLDivElement | null>}
                  messages={messages}
                  setMessages={setMessages}
                  onRegenerate={handleRegenerate}
                  onRetry={handleRetry}
                  onReconnect={() => {
                    resetReconnect();
                    resumeStream();
                  }}
                  onEditMessage={handleEditMessage}
                  onBranchMessage={handleBranchMessage}
                  status={status}
                  error={error || null}
                  isReconnecting={isReconnecting}
                  reconnectExhausted={reconnectExhausted}
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
                  isLocalProvider={isCodexLocal(selectedModel)}
                />
              ) : (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex-1 flex flex-col items-center justify-center px-4 min-h-0">
                    <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center">
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
                          <HackingSuggestions />
                        )}
                      </div>

                      {/* Centered input (desktop only) */}
                      {!isMobile && (
                        <div className="w-full">
                          <ChatInput
                            onSubmit={handleSubmit}
                            onStop={handleStop}
                            onSendNow={handleSendNow}
                            status={status}
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
                    status={status}
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
                <ComputerSidebar messages={messages} status={status} />
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
              <ComputerSidebar messages={messages} status={status} />
            </div>
          </div>
        )}
      </div>
    </ConvexErrorBoundary>
  );
};
