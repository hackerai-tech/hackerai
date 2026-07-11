"use client";

import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import dynamic from "next/dynamic";
import {
  useRef,
  useEffect,
  useState,
  useReducer,
  useCallback,
  useMemo,
  type RefObject,
} from "react";
import {
  useQuery,
  usePaginatedQuery,
  useMutation,
  useConvexAuth,
} from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FileDetails } from "@/types/file";
import { Messages } from "./Messages";
import { ChatInput } from "./ChatInput";
import type { RateLimitWarningData } from "./RateLimitWarning";
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
import {
  fetchWithErrorHandlers,
  convertToUIMessages,
  type MessageRecord,
} from "@/lib/utils";
import {
  cancelAgentLongRealtimeStreams,
  fetchAgentLongStream,
  resumeAgentLongStream,
} from "@/lib/chat/agent-long-transport";
import {
  LEGACY_DESKTOP_AGENT_UPDATE_MESSAGE,
  isLegacyDesktopAgentClient,
  shouldUseAgentLongForAgent,
} from "@/lib/chat/agent-routing";
import {
  AGENT_PARTIAL_SAVE_ENDPOINT,
  AGENT_RESUME_ENDPOINT,
  LEGACY_AGENT_RESUME_ENDPOINT,
} from "@/lib/api/agent-endpoints";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import {
  stripAgentLongHeartbeatParts,
  stripAgentLongHeartbeatPartsFromMessages,
} from "@/lib/chat/agent-long-heartbeat";
import { hasVisibleAssistantContent } from "@/lib/chat/abort-persistence";
import { toast } from "sonner";
import {
  addAuthenticatedExceptionStep,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";
import {
  FREE_AGENT_VALUE_NUDGE_ANALYTICS,
  FREE_AGENT_VALUE_NUDGE_PART_TYPE,
  hasShownFreeAgentValueNudge,
  markFreeAgentValueNudgeShown,
} from "@/lib/chat/free-agent-value-nudge";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import {
  normalizeSelectedModelForSubscription,
  type Todo,
  type ChatMessage,
  type ChatMode,
} from "@/types";
import { coerceSelectedModel } from "@/types/chat";
import { v4 as uuidv4 } from "uuid";
import { useIsMobile } from "@/hooks/use-mobile";
import { useParams, useRouter } from "next/navigation";
import { ConvexErrorBoundary } from "./ConvexErrorBoundary";
import { useAutoResume } from "../hooks/useAutoResume";
import { useAutoContinue } from "../hooks/useAutoContinue";
import { useLatestRef } from "../hooks/useLatestRef";
import { useDataStreamDispatch } from "./DataStreamProvider";
import { removeDraft } from "@/lib/utils/client-storage";
import { parseRateLimitWarning } from "@/lib/utils/parse-rate-limit-warning";
import Loading from "@/components/ui/loading";

import { HackingSuggestions } from "./HackingSuggestions";

const AGENT_LONG_COMPLETION_POLL_DELAY_MS = 5_000;
const AGENT_LONG_COMPLETION_POLL_INTERVAL_MS = 2_000;
const AGENT_LONG_COMPLETION_QUIET_MS = 3_000;
const AGENT_LONG_COMPLETION_STOP_GRACE_MS = 6_000;
type MessagePaginationStatus =
  "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export function getExistingChatLoadState({
  isExistingChat,
  hasMessages,
  isConvexAuthLoading,
  isConvexAuthenticated,
  shouldFetchMessages,
  chatData,
  paginationStatus,
  hasPaginatedMessageResults,
  awaitingServerChat,
}: {
  isExistingChat: boolean;
  hasMessages: boolean;
  isConvexAuthLoading: boolean;
  isConvexAuthenticated: boolean;
  shouldFetchMessages: boolean;
  chatData: unknown;
  paginationStatus?: MessagePaginationStatus;
  hasPaginatedMessageResults: boolean;
  awaitingServerChat: boolean;
}) {
  const isInitialExistingChatLoad =
    isExistingChat &&
    !hasMessages &&
    (isConvexAuthLoading ||
      !isConvexAuthenticated ||
      (shouldFetchMessages &&
        (chatData === undefined || paginationStatus === "LoadingFirstPage")));

  const isChatNotFound =
    isExistingChat &&
    chatData === null &&
    shouldFetchMessages &&
    !awaitingServerChat &&
    paginationStatus !== "LoadingFirstPage" &&
    !hasPaginatedMessageResults;

  return { isInitialExistingChatLoad, isChatNotFound };
}

export function useServerMessages(
  paginatedMessageResults: MessageRecord[] | undefined,
): ChatMessage[] {
  return useMemo(
    () =>
      paginatedMessageResults && paginatedMessageResults.length > 0
        ? convertToUIMessages([...paginatedMessageResults].reverse())
        : [],
    [paginatedMessageResults],
  );
}

type AgentLongPartialSaveMessage = {
  id: string;
  role: "assistant";
  parts: ChatMessage["parts"];
  generationStartedAt?: number;
  generationTimeMs?: number;
};

const getLatestAgentLongAssistantMessageForPartialSave = (
  messages: ChatMessage[],
): AgentLongPartialSaveMessage | undefined => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") return undefined;

  const stripped = stripAgentLongHeartbeatParts(message);
  if (!stripped.parts || stripped.parts.length === 0) return undefined;
  if (!hasVisibleAssistantContent([stripped])) return undefined;

  const metadata = (
    stripped as ChatMessage & {
      metadata?: {
        generationStartedAt?: unknown;
        generationTimeMs?: unknown;
      };
    }
  ).metadata;

  return {
    id: stripped.id,
    role: "assistant",
    parts: stripped.parts,
    generationStartedAt:
      typeof metadata?.generationStartedAt === "number"
        ? metadata.generationStartedAt
        : undefined,
    generationTimeMs:
      typeof metadata?.generationTimeMs === "number"
        ? metadata.generationTimeMs
        : undefined,
  };
};

const getAgentLongPartFingerprint = (part: unknown): string => {
  if (typeof part !== "object" || part === null) return String(part);
  const typedPart = part as {
    type?: unknown;
    text?: unknown;
    delta?: unknown;
    state?: unknown;
  };
  const type = typeof typedPart.type === "string" ? typedPart.type : "unknown";
  const textLength =
    typeof typedPart.text === "string" ? typedPart.text.length : undefined;
  const deltaLength =
    typeof typedPart.delta === "string" ? typedPart.delta.length : undefined;
  if (textLength !== undefined || deltaLength !== undefined) {
    return `${type}:${textLength ?? 0}:${deltaLength ?? 0}:${typedPart.state ?? ""}`;
  }

  try {
    return `${type}:${JSON.stringify(part).length}`;
  } catch {
    return type;
  }
};

const getAgentLongMessageFingerprint = (messages: ChatMessage[]): string =>
  messages
    .map(
      (message) =>
        `${message.id}:${message.role}:${(message.parts ?? [])
          .map(getAgentLongPartFingerprint)
          .join(",")}`,
    )
    .join("|");

const ComputerSidebar = dynamic(
  () => import("./ComputerSidebar").then((m) => m.ComputerSidebar),
  { ssr: false },
);

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
  | { type: "RESET_ON_FINISH" }
  | { type: "RESET_ON_CHAT_CHANGE" };

const initialStreamingState: StreamingEphemeralState = {
  uploadStatus: null,
  summarizationStatus: null,
  rateLimitWarning: null,
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
    case "RESET_ON_FINISH":
      if (state.uploadStatus === null && state.summarizationStatus === null)
        return state;
      return {
        ...state,
        uploadStatus: null,
        summarizationStatus: null,
      };
    case "RESET_ON_CHAT_CHANGE":
      if (
        state.uploadStatus === null &&
        state.summarizationStatus === null &&
        state.rateLimitWarning === null
      ) {
        return state;
      }
      return initialStreamingState;
    default:
      return state;
  }
}

function getLatestTodoWriteOutput(messages: ChatMessage[]):
  | {
      key: string;
      todos: Todo[];
    }
  | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    const parts = message.parts || [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex] as any;
      const currentTodos = part?.output?.currentTodos;
      if (
        part?.type === "tool-todo_write" &&
        part?.state === "output-available" &&
        Array.isArray(currentTodos)
      ) {
        return {
          key: `${message.id}:${part.toolCallId || partIndex}`,
          todos: currentTodos as Todo[],
        };
      }
    }
  }
  return undefined;
}

// Renderless component that isolates dataStream state subscriptions
// (useAutoResume + useAutoContinue) from the Chat component.
// Without this boundary, Chat subscribes to DataStreamStateContext
// through these hooks and re-renders on every stream chunk.
function StreamEffects({
  chatId,
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
  hasActiveStream,
}: {
  chatId: string;
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
  hasActiveStream: boolean | undefined;
}) {
  useAutoResume({
    chatId,
    autoResume,
    initialMessages: serverMessages,
    resumeStream,
    setMessages,
    hasActiveStream,
  });

  const { resetAutoContinueCount } = useAutoContinue({
    chatId,
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
  const {
    isLoading: isConvexAuthLoading,
    isAuthenticated: isConvexAuthenticated,
  } = useConvexAuth();
  const [streamingState, dispatchStreaming] = useReducer(
    streamingReducer,
    initialStreamingState,
  );
  const { uploadStatus, summarizationStatus, rateLimitWarning } =
    streamingState;

  const {
    input,
    chatMode,
    setChatMode,
    sidebarOpen,
    chatSidebarOpen,
    setChatSidebarOpen,
    initializeChat,
    setTodos,
    temporaryChatsEnabled,
    setChatReset,
    hasUserDismissedRateLimitWarning,
    setHasUserDismissedRateLimitWarning,
    messageQueue,
    removeQueuedMessage,
    clearQueue,
    queueBehavior,
    todos,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
    subscription,
    localConnections,
  } = useGlobalState();

  // Simple logic: use route chatId if provided, otherwise generate new one
  const [chatId, setChatId] = useState<string>(() => {
    return routeChatId || uuidv4();
  });

  // Track whether this is an existing chat (prop-driven initially, flips after first completion)
  const [isExistingChat, setIsExistingChat] = useState<boolean>(!!routeChatId);
  const wasNewChatRef = useRef(!routeChatId);
  const shouldFetchMessages =
    isExistingChat && !isConvexAuthLoading && isConvexAuthenticated;

  // Refs to avoid stale closures in callbacks
  const isExistingChatRef = useLatestRef(isExistingChat);
  const chatModeRef = useLatestRef(chatMode);
  const subscriptionRef = useLatestRef(subscription);

  // Suppress transient "Chat Not Found" while server creates the chat
  const [awaitingServerChat, setAwaitingServerChat] = useState<boolean>(false);

  // Store file metadata separately from AI SDK message state (for temporary chats)
  const [tempChatFileDetails, setTempChatFileDetails] = useState<
    Map<string, FileDetails[]>
  >(new Map());

  // Title streamed mid-response so the header updates before Convex persists it
  const [streamedTitle, setStreamedTitle] = useState<string | null>(null);

  const temporaryChatsEnabledRef = useLatestRef(temporaryChatsEnabled);
  // Use global state ref so streaming callback reads latest value
  const hasUserDismissedWarningRef = useLatestRef(
    hasUserDismissedRateLimitWarning,
  );
  // Use ref for todos to avoid stale closures in auto-send
  const todosRef = useLatestRef(todos);
  // Use ref for sandbox preference to avoid stale closures in auto-send
  const sandboxPreferenceRef = useLatestRef(sandboxPreference);
  const requestSelectedModel = normalizeSelectedModelForSubscription(
    selectedModel,
    subscription,
  );
  const shouldUseAgentLong = shouldUseAgentLongForAgent({
    mode: chatMode,
    subscription,
    isTauri: isTauriEnvironment(),
  });
  // Use ref for model selection to avoid stale closures in auto-send
  const requestSelectedModelRef = useLatestRef(requestSelectedModel);
  const lastAppliedTodoOutputRef = useRef<string | null>(null);

  // Ensure we only initialize mode from server once per chat id
  const hasInitializedModeFromChatRef = useRef(false);
  // Track whether sandbox preference has been initialized from chat for this chat id
  const hasInitializedSandboxRef = useRef(false);
  // Track whether the stored sandbox connection was validated (stale connections unlock the selector)
  const hasInitializedModelRef = useRef(false);
  // Snapshot of the last picker values successfully persisted to the chat doc.
  // Seeded after init from chatData; subsequent picker toggles trigger a debounced patch.
  const persistedPrefsRef = useRef<{ model: string; mode: string } | null>(
    null,
  );

  // Sync local chat state from URL (single source of truth)
  useEffect(() => {
    setStreamedTitle(null);
    lastAppliedTodoOutputRef.current = null;
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

  const chatDataForCurrentChat =
    chatData && (chatData as any).id === chatId ? chatData : undefined;
  const paginatedMessageResults =
    paginatedMessages.results &&
    paginatedMessages.results.length > 0 &&
    paginatedMessages.results.every(
      (message: any) => message.chat_id === chatId,
    )
      ? paginatedMessages.results
      : undefined;

  // Use the shared local sandbox connection subscription when validating a saved non-E2B sandbox.
  const storedSandboxType = (chatDataForCurrentChat as any)?.sandbox_type as
    string | undefined;

  // Prefer the mid-stream title — the server seeds chatData.title with the
  // user's first message before generation completes, which would otherwise
  // flicker into the header on abort.
  const chatTitle = streamedTitle ?? chatDataForCurrentChat?.title ?? null;
  const activeTriggerRunRef = useLatestRef(
    (chatDataForCurrentChat as any)?.active_trigger_run_id as
      string | undefined,
  );

  // Convert paginated Convex messages to UI format for useChat and useAutoResume
  // Messages come from server in descending order (newest first from pagination); reverse for chronological order
  const serverMessages = useServerMessages(paginatedMessageResults);

  // State to prevent double-processing of queue
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  // Ref to track when "Send Now" is actively processing to prevent auto-processing interference
  const isSendingNowRef = useRef(false);
  // Ref to track if user manually stopped - prevents auto-processing until new message submitted
  const hasManuallyStoppedRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const isChatMountedRef = useRef(false);
  const browserStreamFinishedRef = useRef(false);
  const activeChatIdRef = useRef(chatId);
  const shownFreeAgentValueNudgeChatsRef = useRef<Set<string>>(new Set());
  const agentLongPartialSaveKeysRef = useRef<Set<string>>(new Set());
  activeChatIdRef.current = chatId;

  useEffect(() => {
    isChatMountedRef.current = true;
    return () => {
      isChatMountedRef.current = false;
    };
  }, []);

  // Ref for setMessages — needed by DefaultChatTransport which is created before useChat returns
  const setMessagesRef = useRef<(messages: any[]) => void>(() => {});

  // Default transport (OpenRouter) - stored in ref since it's created before useChat
  const transportRef = useRef(
    new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
        const mode = chatModeRef.current;
        const isTauri = isTauriEnvironment();
        if (isLegacyDesktopAgentClient({ mode, isTauri })) {
          throw new ChatSDKError(
            "forbidden:chat",
            LEGACY_DESKTOP_AGENT_UPDATE_MESSAGE,
          );
        }
        const useTriggerAgent = shouldUseAgentLongForAgent({
          mode,
          subscription: subscriptionRef.current,
          isTauri,
        });
        if (useTriggerAgent) {
          // useChat reuses this fetch for both POST sendMessages and GET
          // reconnectToStream — dispatch on method.
          if (init?.method === "GET") {
            return resumeAgentLongStream(
              typeof input === "string" ? input : input.toString(),
              init,
            );
          }
          return fetchAgentLongStream(init);
        }
        // Reconnect for legacy "agent-long" chats normalised to "agent" mode
        // on load — route based on the URL (not on ref state) to be resilient
        // to stale refs.
        if (
          init?.method === "GET" &&
          [AGENT_RESUME_ENDPOINT, LEGACY_AGENT_RESUME_ENDPOINT].some(
            (resumeEndpoint) =>
              (typeof input === "string" ? input : input.toString()).includes(
                resumeEndpoint,
              ),
          )
        ) {
          return resumeAgentLongStream(
            typeof input === "string" ? input : input.toString(),
            init,
          );
        }
        return fetchWithErrorHandlers(input, init);
      },
      prepareReconnectToStreamRequest: ({ id, api }) => {
        // Use the Trigger-backed Agent resume endpoint when there is a stored
        // trigger run (covers legacy "agent-long" chats normalised to "agent")
        // or when the current run is using Trigger.dev for agent mode.
        const useTriggerAgent = shouldUseAgentLongForAgent({
          mode: chatModeRef.current,
          subscription: subscriptionRef.current,
          isTauri: isTauriEnvironment(),
        });
        if (useTriggerAgent || !!activeTriggerRunRef.current) {
          return {
            api: `${AGENT_RESUME_ENDPOINT}?chatId=${encodeURIComponent(id)}`,
          };
        }
        return { api: `${api}/${id}/stream` };
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
          const messagesWithoutHeartbeats =
            stripAgentLongHeartbeatPartsFromMessages(msgs);
          return messagesWithoutHeartbeats.map((msg) => {
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

    transport: transportRef.current,

    onData: (dataPart) => {
      if (!isChatMountedRef.current || activeChatIdRef.current !== chatId) {
        return;
      }
      setDataStream((ds) => [...ds, { ...dataPart, __chatId: chatId }]);
      switch (dataPart.type) {
        case FREE_AGENT_VALUE_NUDGE_PART_TYPE: {
          if (
            hasShownFreeAgentValueNudge(
              shownFreeAgentValueNudgeChatsRef.current,
              chatId,
            )
          ) {
            break;
          }

          markFreeAgentValueNudgeShown(
            shownFreeAgentValueNudgeChatsRef.current,
            chatId,
          );
          captureUpgradeCtaImpression(FREE_AGENT_VALUE_NUDGE_ANALYTICS);
          toast.info("Agent worked locally", {
            description:
              "Upgrade for cloud Agent, longer runs, stronger models, files, and higher limits.",
            duration: 10000,
            action: {
              label: "Upgrade",
              onClick: () =>
                redirectToPricing(FREE_AGENT_VALUE_NUDGE_ANALYTICS),
            },
          });
          break;
        }
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
        case "data-title": {
          const titleData = dataPart.data as { chatTitle?: string };
          if (titleData?.chatTitle) {
            setStreamedTitle(titleData.chatTitle);
          }
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
              ? `Local sandbox unavailable. Using ${fallbackData.actualSandboxName || "Cloud"}; host files, drives, localhost, and private networks are unavailable until local reconnects.`
              : `Selected sandbox disconnected. Switched to ${fallbackData.actualSandboxName || "Cloud"}. Commands run there, not on the selected host.`;
          toast.info(message, { duration: 8000 });
          break;
        }
      }
    },
    onFinish: () => {
      browserStreamFinishedRef.current = true;
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });

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
      browserStreamFinishedRef.current = true;
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });
      if (error instanceof ChatSDKError) {
        const errorMessage =
          typeof error.cause === "string" ? error.cause : error.message;
        if (error.type !== "rate_limit") {
          toast.error(errorMessage);
        }
      } else if (isMobile && error.name !== "AbortError") {
        toast.error(error.message || "An error occurred.");
      }
    },
  });

  const previousChatStatusRef = useRef<typeof status | null>(null);
  useEffect(() => {
    previousChatStatusRef.current = null;
  }, [chatId]);
  useEffect(() => {
    const previousStatus = previousChatStatusRef.current;
    if (previousStatus === status) return;

    addAuthenticatedExceptionStep("chat_status_changed", {
      previous_status: previousStatus ?? "initial",
      status,
      mode: chatModeRef.current,
      subscription: subscriptionRef.current,
      transport: shouldUseAgentLong ? "trigger" : "browser",
      existing_chat: isExistingChatRef.current,
      temporary_chat: temporaryChatsEnabledRef.current,
      message_count: messagesRef.current.length,
    });
    previousChatStatusRef.current = status;
  }, [
    chatModeRef,
    isExistingChatRef,
    shouldUseAgentLong,
    status,
    subscriptionRef,
    temporaryChatsEnabledRef,
  ]);

  // Keep refs in sync so closures read latest values
  setMessagesRef.current = setMessages;
  messagesRef.current = messages;

  useEffect(() => {
    const shouldApplyOutput =
      status === "streaming" || status === "submitted" || !shouldFetchMessages;
    if (!shouldApplyOutput) return;

    const latestTodoOutput = getLatestTodoWriteOutput(
      messages as ChatMessage[],
    );
    if (!latestTodoOutput) return;
    if (lastAppliedTodoOutputRef.current === latestTodoOutput.key) return;

    lastAppliedTodoOutputRef.current = latestTodoOutput.key;
    setTodos(latestTodoOutput.todos);
  }, [messages, setTodos, shouldFetchMessages, status]);

  // Ref (not state) so the Convex sync effect only fires when paginatedMessages.results
  // changes, not on status transitions — avoiding the stale-data overwrite on stream stop.
  const statusRef = useRef(status);
  statusRef.current = status;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const shouldUseAgentLongForCurrentChat =
    shouldUseAgentLong &&
    (!isExistingChat ||
      (!!chatDataForCurrentChat &&
        (!!chatDataForCurrentChat.active_trigger_run_id ||
          (chatDataForCurrentChat as any).default_model_slug === "agent" ||
          (chatDataForCurrentChat as any).default_model_slug ===
            "agent-long")));
  const shouldUseAgentLongForCurrentChatRef = useRef(
    shouldUseAgentLongForCurrentChat,
  );
  shouldUseAgentLongForCurrentChatRef.current =
    shouldUseAgentLongForCurrentChat;
  const stopActiveBrowserStream = useCallback(() => {
    cancelAgentLongRealtimeStreams(activeChatIdRef.current);
    const streamAlreadyFinished =
      shouldUseAgentLongForCurrentChatRef.current &&
      browserStreamFinishedRef.current;
    if (
      !streamAlreadyFinished &&
      (statusRef.current === "streaming" || statusRef.current === "submitted")
    ) {
      stopRef.current();
    }
    setDataStream([]);
    setIsAutoResuming(false);
  }, [setDataStream, setIsAutoResuming]);

  const saveAgentLongPartialSnapshot = useCallback(
    (clientReason: string) => {
      const partialMessage = getLatestAgentLongAssistantMessageForPartialSave(
        messagesRef.current,
      );
      if (!partialMessage) return;

      const saveKey = `${chatId}:${partialMessage.id}`;
      if (agentLongPartialSaveKeysRef.current.has(saveKey)) return;
      agentLongPartialSaveKeysRef.current.add(saveKey);

      void fetch(AGENT_PARTIAL_SAVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          message: partialMessage,
          generationStartedAt: partialMessage.generationStartedAt,
          generationTimeMs: partialMessage.generationTimeMs,
          clientReason,
        }),
      })
        .then((response) => {
          if (!response.ok) {
            agentLongPartialSaveKeysRef.current.delete(saveKey);
          }
        })
        .catch(() => {
          agentLongPartialSaveKeysRef.current.delete(saveKey);
        });
    },
    [chatId],
  );

  useEffect(() => {
    if (
      shouldUseAgentLongForCurrentChat &&
      (status === "streaming" || status === "submitted")
    ) {
      browserStreamFinishedRef.current = false;
    }
  }, [shouldUseAgentLongForCurrentChat, status]);

  useEffect(() => {
    const isAgentLongDoubleCloseNoise = (message: unknown) =>
      shouldUseAgentLongForCurrentChatRef.current &&
      typeof message === "string" &&
      (message.includes("Cannot close an errored readable stream") ||
        message.includes(
          "ReadableStreamDefaultController is not in a state where it can be closed",
        ) ||
        message.includes("Cannot close a stream that is already closed"));

    const suppressAgentLongDoubleCloseNoise = (event: ErrorEvent) => {
      if (isAgentLongDoubleCloseNoise(event.message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    const previousOnError = window.onerror;
    const suppressAgentLongDoubleCloseOnError: OnErrorEventHandler = (
      message,
      source,
      lineno,
      colno,
      error,
    ) => {
      if (isAgentLongDoubleCloseNoise(message)) return true;
      if (typeof previousOnError === "function") {
        try {
          return previousOnError(message, source, lineno, colno, error);
        } catch {
          return false;
        }
      }
      return false;
    };
    window.onerror = suppressAgentLongDoubleCloseOnError;

    window.addEventListener("error", suppressAgentLongDoubleCloseNoise, true);
    return () => {
      if (window.onerror === suppressAgentLongDoubleCloseOnError) {
        window.onerror = previousOnError;
      }
      window.removeEventListener(
        "error",
        suppressAgentLongDoubleCloseNoise,
        true,
      );
    };
  }, []);

  useEffect(() => {
    setDataStream([]);
    setIsAutoResuming(false);
    dispatchStreaming({ type: "RESET_ON_CHAT_CHANGE" });
  }, [chatId, setDataStream, setIsAutoResuming]);

  useEffect(() => {
    return () => {
      stopActiveBrowserStream();
    };
  }, [stopActiveBrowserStream]);

  const agentLongMessageFingerprint = getAgentLongMessageFingerprint(messages);
  const agentLongMessageFingerprintRef = useRef(agentLongMessageFingerprint);
  const agentLongLastMessageChangeAtRef = useRef(Date.now());

  useEffect(() => {
    if (
      agentLongMessageFingerprintRef.current === agentLongMessageFingerprint
    ) {
      return;
    }
    agentLongMessageFingerprintRef.current = agentLongMessageFingerprint;
    agentLongLastMessageChangeAtRef.current = Date.now();
  }, [agentLongMessageFingerprint]);

  // Trigger.dev can finish and persist an Agent answer even if the realtime
  // UI stream never delivers a terminal chunk to useChat. Reconcile against
  // the app's authenticated resume endpoint so the first message in a new
  // chat can leave "Working..." even before chatData is subscribed.
  useEffect(() => {
    if (
      status !== "streaming" ||
      !shouldUseAgentLongForCurrentChat ||
      temporaryChatsEnabled
    ) {
      return;
    }

    let stopped = false;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let finishTimeout: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();

    const finishLocally = () => {
      if (stopped) return;
      stopped = true;
      stop();
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });

      if (!isExistingChatRef.current) {
        window.history.replaceState({}, "", `/c/${chatId}`);
        removeDraft("new");
        setIsExistingChat(true);
      }
    };

    const scheduleFinishLocally = () => {
      if (stopped || finishTimeout !== undefined) return;
      saveAgentLongPartialSnapshot("resume_terminal_204");

      // The transport also polls the resume endpoint and can deliver a
      // synthetic finish after a terminal 204. Give it a brief chance to close
      // normally before falling back to stop(), which aborts the active stream.
      finishTimeout = setTimeout(() => {
        finishTimeout = undefined;
        if (
          statusRef.current === "streaming" ||
          statusRef.current === "submitted"
        ) {
          finishLocally();
        }
      }, AGENT_LONG_COMPLETION_STOP_GRACE_MS);
    };

    const checkRunCompletion = async () => {
      if (
        Date.now() - agentLongLastMessageChangeAtRef.current <
        AGENT_LONG_COMPLETION_QUIET_MS
      ) {
        return;
      }

      try {
        const response = await fetch(
          `${AGENT_RESUME_ENDPOINT}?chatId=${encodeURIComponent(chatId)}`,
          { method: "GET", signal: abortController.signal },
        );
        if (response.status === 204) {
          scheduleFinishLocally();
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          // Ignore transient polling failures; the underlying stream still owns
          // the visible error state.
        }
      }
    };

    const pollDelay = setTimeout(() => {
      void checkRunCompletion();
      pollInterval = setInterval(() => {
        void checkRunCompletion();
      }, AGENT_LONG_COMPLETION_POLL_INTERVAL_MS);
    }, AGENT_LONG_COMPLETION_POLL_DELAY_MS);

    return () => {
      stopped = true;
      abortController.abort();
      clearTimeout(pollDelay);
      if (finishTimeout !== undefined) {
        clearTimeout(finishTimeout);
      }
      if (pollInterval !== undefined) {
        clearInterval(pollInterval);
      }
    };
  }, [
    chatId,
    isExistingChatRef,
    setIsAutoResuming,
    saveAgentLongPartialSnapshot,
    shouldUseAgentLongForCurrentChat,
    status,
    stop,
    temporaryChatsEnabled,
  ]);

  // Ref bridge: StreamEffects exposes resetAutoContinueCount here
  const resetAutoContinueRef = useRef<(() => void) | null>(null);
  const resetAutoContinueCount = useCallback(() => {
    resetAutoContinueRef.current?.();
  }, []);

  // Register a reset function with global state so initializeNewChat can call it
  useEffect(() => {
    const reset = () => {
      stopActiveBrowserStream();
      setMessages([]);
      setChatId(uuidv4());
      setIsExistingChat(false);
      wasNewChatRef.current = true;
      setTodos([]);
      setStreamedTitle(null);
      setAwaitingServerChat(false);
      dispatchStreaming({ type: "RESET_ON_FINISH" });
      setHasUserDismissedRateLimitWarning(false);
      resetAutoContinueCount();
    };
    setChatReset(reset);
    return () => setChatReset(null);
  }, [
    setChatReset,
    setMessages,
    setTodos,
    resetAutoContinueCount,
    stopActiveBrowserStream,
  ]);

  // Reset the one-time initializer when chat changes (must come before chatData effect to handle cached data)
  useEffect(() => {
    hasInitializedModeFromChatRef.current = false;
    hasInitializedSandboxRef.current = false;
    hasInitializedModelRef.current = false;
    persistedPrefsRef.current = null;
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
    const coerced = coerceSelectedModel(savedModel ?? null);
    if (coerced) {
      setSelectedModel(coerced);
    }
  }, [chatData, isExistingChat, chatId]);

  // Persist picker preferences (model + mode) when the user toggles them.
  // Debounced so quick toggles don't spam Convex; baseline is seeded from the
  // chat's stored values so the post-init render doesn't trigger a no-op write.
  const updateChatPreferences = useMutation(api.chats.updateChatPreferences);
  useEffect(() => {
    if (!isExistingChat || !chatData) return;
    const dataId = (chatData as any).id as string | undefined;
    if (dataId !== chatId) return;
    if (
      !hasInitializedModelRef.current ||
      !hasInitializedModeFromChatRef.current
    ) {
      return;
    }

    if (persistedPrefsRef.current === null) {
      const savedModel = (chatData as any).selected_model as string | undefined;
      const savedMode = (chatData as any).default_model_slug as
        string | undefined;
      persistedPrefsRef.current = {
        model: savedModel ?? selectedModel,
        mode: savedMode ?? chatMode,
      };
    }

    const last = persistedPrefsRef.current;
    if (last.model === selectedModel && last.mode === chatMode) return;

    // `cancelled` guards both branches: clearTimeout cancels before the
    // request fires, and the flag prevents an in-flight request from writing
    // its (stale) snapshot to persistedPrefsRef after the user has already
    // navigated to a different chat or toggled again.
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const snapshot = { model: selectedModel, mode: chatMode };
      void updateChatPreferences({
        id: chatId,
        selectedModel,
        mode: chatMode,
      })
        .then(() => {
          if (cancelled) return;
          persistedPrefsRef.current = snapshot;
        })
        .catch(() => {
          // Silent — picker state in memory is still correct; backend will
          // re-persist on next send via updateChat.
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    selectedModel,
    chatMode,
    isExistingChat,
    chatId,
    chatData,
    updateChatPreferences,
  ]);

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
    if (!paginatedMessageResults || paginatedMessageResults.length === 0) {
      return;
    }

    const uiMessages = convertToUIMessages(
      [...paginatedMessageResults].reverse(),
    );

    // Skip if useChat already has the same messages (same IDs, same part count).
    // This prevents redundant setMessages calls — e.g. after a local provider
    // save, Convex echoes the same data back via reactive query, which would
    // otherwise cause a visible flicker from new object references.
    // Comparing parts.length catches content updates where the ID stays the same.
    const current = messagesRef.current;

    // Don't overwrite with fewer messages — the backend (e.g. agent-long Trigger.dev
    // task) hasn't finished persisting the generated messages yet. Once it catches
    // up, Convex will push the full set and the normal sync below will apply.
    if (uiMessages.length < current.length) {
      return;
    }

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

    // Don't let Convex reorder messages that already exist locally. The trigger
    // task's onFinish saves the assistant message after the stream finishes, so
    // the next user message may land in Convex first (_creationTime ordering).
    // Local ordering is authoritative; only accept additive/content updates.
    const currentIdSet = new Set(current.map((m) => m.id));
    const uiIdSet = new Set(uiMessages.map((m) => m.id));
    const uiSharedOrder = uiMessages
      .map((m) => m.id)
      .filter((id) => currentIdSet.has(id));
    const currentSharedOrder = current
      .map((m) => m.id)
      .filter((id) => uiIdSet.has(id));
    if (
      uiSharedOrder.length > 0 &&
      uiSharedOrder.join("\0") !== currentSharedOrder.join("\0")
    ) {
      return;
    }

    if (isExistingChat) {
      setMessages(uiMessages);
    }
  }, [paginatedMessageResults, setMessages, isExistingChat, chatId]);

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

  // Re-arm sticky scroll whenever a new user message is appended at the tail.
  // Stop+send flows (Send Now, stop-and-send) mutate the DOM mid-stream which
  // knocks use-stick-to-bottom out of "at bottom" state, so we force-scroll on
  // the new user message to resume following the next generation. Keyed on
  // tail-id (not length) so pagination prepends don't trigger a scroll jump.
  const lastMessage = messages[messages.length - 1];
  const lastId = lastMessage?.id;
  const lastRole = lastMessage?.role;
  const prevLastIdRef = useRef<string | undefined>(lastId);
  useEffect(() => {
    const prevLastId = prevLastIdRef.current;
    prevLastIdRef.current = lastId;
    if (lastId && lastId !== prevLastId && lastRole === "user") {
      scrollToBottom({ force: true });
    }
  }, [lastId, lastRole, scrollToBottom]);

  // Keep a ref to the latest messageQueue to avoid stale closures
  const messageQueueRef = useLatestRef(messageQueue);

  // Clear queue when navigating to a different chat.
  // Intentionally reads messageQueueRef at cleanup time (latest value).
  useEffect(() => {
    return () => {
      if (messageQueueRef.current.length > 0) {
        clearQueue();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const nextMessage = messageQueue[0];

      if (nextMessage) {
        try {
          const sendPromise = sendMessage(
            {
              text: nextMessage.text,
              files: nextMessage.files as any,
              metadata: { createdAt: nextMessage.timestamp },
            },
            {
              body: {
                mode: chatModeRef.current,
                todos: todosRef.current,
                temporary: temporaryChatsEnabledRef.current,
                sandboxPreference: sandboxPreferenceRef.current,
                selectedModel: requestSelectedModelRef.current,
              },
            },
          );
          removeQueuedMessage(nextMessage.id);
          sendPromise.catch((error) => {
            console.error("Failed to send queued message:", error);
          });
        } catch (error) {
          console.error("Failed to send queued message:", error);
        }
      }

      setTimeout(() => setIsProcessingQueue(false), 100);
    }
  }, [
    status,
    messageQueue,
    isProcessingQueue,
    removeQueuedMessage,
    sendMessage,
    queueBehavior,
    chatModeRef,
    todosRef,
    temporaryChatsEnabledRef,
    sandboxPreferenceRef,
    requestSelectedModelRef,
  ]);

  // Chat handlers
  const {
    handleSubmit,
    handleStop,
    handleRegenerate,
    handleRetry,
    handleEditMessage,
    handleSendNow,
    handleContinue,
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
      dispatchStreaming({ type: "RESET_ON_FINISH" });
    },
    resetAutoContinueCount,
  });

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom({ force: true });
  }, [scrollToBottom]);

  // Rate limit warning dismiss handler
  const handleDismissRateLimitWarning = useCallback(() => {
    dispatchStreaming({ type: "SET_RATE_LIMIT_WARNING", payload: null });
    setHasUserDismissedRateLimitWarning(true);
  }, [setHasUserDismissedRateLimitWarning]);

  // Branch chat handler
  const branchChatMutation = useMutation(api.messages.branchChat);

  const handleBranchMessage = useCallback(
    async (messageId: string) => {
      try {
        const newChatId = await branchChatMutation({ messageId });
        if (!newChatId) {
          toast.error("That message is no longer available to branch.");
          return;
        }
        initializeChat(newChatId);
        router.push(`/c/${newChatId}`);
      } catch (error) {
        console.error("Failed to branch chat:", error);
        toast.error("Failed to branch chat. Please try again.");
      }
    },
    [branchChatMutation, initializeChat, router],
  );

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
  const { isInitialExistingChatLoad, isChatNotFound } =
    getExistingChatLoadState({
      isExistingChat,
      hasMessages,
      isConvexAuthLoading,
      isConvexAuthenticated,
      shouldFetchMessages,
      chatData,
      paginationStatus: paginatedMessages.status,
      hasPaginatedMessageResults: !!paginatedMessageResults,
      awaitingServerChat,
    });
  const agentRunSpendCapWarning =
    rateLimitWarning?.warningType === "agent-run-spend-cap"
      ? rateLimitWarning
      : undefined;

  // UI-level temporary chat flag
  const isTempChat = !isExistingChat && temporaryChatsEnabled;

  // Get branched chat info directly from chatData (no additional query needed)
  const branchedFromChatId = chatDataForCurrentChat?.branched_from_chat_id;
  const branchedFromChatTitle = (chatDataForCurrentChat as any)
    ?.branched_from_title;

  return (
    <ConvexErrorBoundary>
      <StreamEffects
        key={chatId}
        chatId={chatId}
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
        selectedModel={requestSelectedModel}
        resetRef={resetAutoContinueRef}
        hasActiveStream={
          chatData === undefined || (chatData && !chatDataForCurrentChat)
            ? undefined
            : !!chatDataForCurrentChat?.active_stream_id ||
              !!chatDataForCurrentChat?.active_trigger_run_id
        }
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
              id={chatId}
              chatData={chatDataForCurrentChat}
              chatSidebarOpen={chatSidebarOpen}
              isExistingChat={isExistingChat}
              isChatNotFound={isChatNotFound}
              branchedFromChatTitle={branchedFromChatTitle}
            />

            {/* Chat interface */}
            <div className="bg-background flex flex-col flex-1 relative min-h-0">
              {/* Messages area */}
              {isInitialExistingChatLoad ? (
                <div className="flex-1 flex items-center justify-center min-h-0">
                  <Loading />
                </div>
              ) : isChatNotFound ? (
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
                  onContinue={handleContinue}
                  onReconnect={resumeStream}
                  onEditMessage={handleEditMessage}
                  onBranchMessage={handleBranchMessage}
                  status={status}
                  error={error || null}
                  paginationStatus={paginatedMessages.status}
                  loadMore={paginatedMessages.loadMore}
                  isTemporaryChat={isTempChat}
                  isMobile={isMobile}
                  tempChatFileDetails={tempChatFileDetails}
                  finishReason={chatDataForCurrentChat?.finish_reason}
                  agentRunSpendCapWarning={agentRunSpendCapWarning}
                  uploadStatus={uploadStatus}
                  summarizationStatus={summarizationStatus}
                  mode={
                    chatMode ??
                    (chatDataForCurrentChat as any)?.default_model_slug
                  }
                  chatTitle={chatTitle}
                  branchedFromChatId={branchedFromChatId}
                  branchedFromChatTitle={branchedFromChatTitle}
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
                !isInitialExistingChatLoad &&
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
