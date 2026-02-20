"use client";

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type RefObject,
} from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
// Realtime streams: client uses SSE (push-based). Whether metadata chunks arrive during a long run
// depends on Trigger's server pushing on each append; see docs/trigger-realtime-streams-findings.md.
import { useRealtimeStream, useRealtimeRun } from "@trigger.dev/react-hooks";
import {
  aiStream,
  metadataStream,
  type MetadataEvent,
} from "@/src/trigger/streams";
import { fetchWithErrorHandlers } from "@/lib/utils";
import { accumulateChunksToMessage } from "@/lib/utils/accumulate-ui-chunks";
import { toast } from "sonner";
import type { ChatMessage, Todo } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";
import type { FileDetails } from "@/types/file";
import type { RateLimitWarningData } from "@/app/components/RateLimitWarning";
import { parseRateLimitWarning } from "@/lib/utils/parse-rate-limit-warning";
import type { SandboxPreference } from "@/types/chat";

export interface UseAgentLongStreamOptions {
  chatId: string;
  enabled: boolean;
  /** When loading a chat that has an active run, pass runId here to reconnect (e.g. from chatData.active_trigger_run_id) */
  reconnectRunId?: string | null;
  messages: ChatMessage[];
  /** Convex-loaded messages; used for reconnect/backfill so history shows on refresh when Convex loads after reconnect */
  serverMessages: ChatMessage[];
  todos: Todo[];
  sandboxPreference: SandboxPreference;
  setUploadStatus: (
    status: { message: string; isUploading: boolean } | null,
  ) => void;
  setSummarizationStatus: (
    status: { status: "started" | "completed"; message: string } | null,
  ) => void;
  setRateLimitWarning: (warning: RateLimitWarningData | null) => void;
  setTempChatFileDetails: React.Dispatch<
    React.SetStateAction<Map<string, FileDetails[]>>
  >;
  setSandboxPreference: (pref: SandboxPreference) => void;
  setDataStream: React.Dispatch<React.SetStateAction<unknown[]>>;
  setIsAutoResuming: (v: boolean) => void;
  setAwaitingServerChat: (v: boolean) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  hasUserDismissedWarningRef: RefObject<boolean>;
  isExistingChatRef: RefObject<boolean>;
  onRunComplete?: (params: { chatId: string }) => void;
}

export interface UseAgentLongStreamReturn {
  isActive: boolean;
  status: "streaming" | "ready" | "error";
  displayMessages: ChatMessage[];
  submit: (
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
  ) => Promise<void>;
  regenerate: (options?: {
    body?: { todos?: Todo[]; sandboxPreference?: string };
  }) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  skipPaginatedSyncUntilRef: RefObject<number>;
  lastTriggerAssistantIdRef: RefObject<string | null>;
}

export function useAgentLongStream(
  options: UseAgentLongStreamOptions,
): UseAgentLongStreamReturn {
  const {
    chatId,
    enabled,
    reconnectRunId,
    messages,
    serverMessages,
    todos,
    sandboxPreference,
    setUploadStatus,
    setSummarizationStatus,
    setRateLimitWarning,
    setTempChatFileDetails,
    setSandboxPreference,
    setDataStream,
    setIsAutoResuming,
    setAwaitingServerChat,
    setMessages,
    hasUserDismissedWarningRef,
    isExistingChatRef,
    onRunComplete,
  } = options;

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

  const skipPaginatedSyncUntilRef = useRef<number>(0);
  const lastTriggerAssistantIdRef = useRef<string | null>(null);
  const aiPartsGenerationRef = useRef(0);
  const reconnectedForRef = useRef<string | null>(null);
  const serverMessagesRef = useRef(serverMessages);
  serverMessagesRef.current = serverMessages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Terminal streaming: collect data-terminal events from metadataStream
  // so they can be injected into the accumulated message's parts for
  // TerminalToolHandler to read (same as regular agent flow).
  const terminalPartsRef = useRef<ChatMessage["parts"]>([]);
  const terminalPartCounterRef = useRef(0);
  const [terminalDataGeneration, setTerminalDataGeneration] = useState(0);
  const cachedAccumulatedMsgRef = useRef<ChatMessage | null>(null);
  const cachedAiPartsRef = useRef<unknown[]>([]);

  const setActiveTriggerRunIdMutation = useMutation(
    api.chatStreams.setActiveTriggerRunId,
  );
  const clearActiveTriggerRunIdMutation = useMutation(
    api.chatStreams.clearActiveTriggerRunId,
  );

  // Backfill: when already reconnected but Convex messages arrived after we set triggerRun,
  // populate triggerBaseAndUserMessages so the UI shows chat history during streaming.
  useEffect(() => {
    if (
      triggerRun !== null &&
      reconnectRunId &&
      serverMessages.length > 0 &&
      triggerBaseAndUserMessages.length === 0
    ) {
      setTriggerBaseAndUserMessages(serverMessages);
    }
  }, [
    triggerRun,
    reconnectRunId,
    serverMessages,
    triggerBaseAndUserMessages.length,
  ]);

  // Reconnect on load: when chat has active_trigger_run_id, fetch token and set triggerRun.
  // Uses refs for messages/serverMessages so this effect only re-runs when the
  // reconnect-relevant deps change (enabled, chatId, reconnectRunId, triggerRun),
  // not on every message update — which previously caused the cleanup to cancel
  // in-flight fetches before they could complete, silently killing reconnection.
  useEffect(() => {
    const reconnectKey = `${chatId}:${reconnectRunId}`;
    if (
      !enabled ||
      !chatId ||
      !reconnectRunId ||
      triggerRun !== null ||
      reconnectedForRef.current === reconnectKey
    ) {
      return;
    }
    reconnectedForRef.current = reconnectKey;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithErrorHandlers(
          `/api/agent-long/token?runId=${encodeURIComponent(reconnectRunId)}&chatId=${encodeURIComponent(chatId)}`,
        );
        if (cancelled || !res.ok) {
          if (!res.ok && !cancelled) {
            const err = await res.json().catch(() => ({}));
            toast.error(err?.message ?? "Failed to reconnect to run");
          }
          // Allow retry on non-cancelled failure
          if (!cancelled) {
            reconnectedForRef.current = null;
          }
          return;
        }
        const { publicAccessToken } = await res.json();
        if (cancelled) return;
        const baseMessages =
          serverMessagesRef.current.length > 0
            ? serverMessagesRef.current
            : messagesRef.current;
        setTriggerRun({ runId: reconnectRunId, publicAccessToken });
        setTriggerBaseAndUserMessages(baseMessages);
        setTriggerAssistantMessage(null);
        setTriggerStatus("streaming");
      } catch (e) {
        if (!cancelled) {
          reconnectedForRef.current = null;
          toast.error(
            e instanceof Error ? e.message : "Failed to reconnect to run",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, chatId, reconnectRunId, triggerRun]);

  // Reset reconnect guard when navigating to a different chat/run
  // so the new chat can reconnect. Using the composite key means the
  // reset only takes effect when chatId or reconnectRunId actually change,
  // NOT on initial mount (which was causing the duplicate fetch).
  useEffect(() => {
    const key = `${chatId}:${reconnectRunId}`;
    if (reconnectedForRef.current && reconnectedForRef.current !== key) {
      reconnectedForRef.current = null;
    }
  }, [chatId, reconnectRunId]);

  const { parts: aiParts = [] } = useRealtimeStream(
    aiStream,
    triggerRun?.runId ?? "",
    {
      accessToken: triggerRun?.publicAccessToken ?? "",
      enabled: enabled && !!triggerRun,
      throttleInMs: 150,
      timeoutInSeconds: 600,
    },
  );
  useRealtimeStream(metadataStream, triggerRun?.runId ?? "", {
    accessToken: triggerRun?.publicAccessToken ?? "",
    enabled: enabled && !!triggerRun,
    onData: (raw: unknown) => {
      // Trigger sends metadata chunks. Handle both string (JSON) and object cases.
      let o: Record<string, unknown>;
      if (typeof raw === "string") {
        if (raw === "[object Object]") return;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed === null || typeof parsed !== "object") return;
          o = parsed as Record<string, unknown>;
        } catch {
          return;
        }
      } else if (raw === null || typeof raw !== "object") {
        return;
      } else {
        o = raw as Record<string, unknown>;
      }
      // Normalize to MetadataEvent: Trigger may send top-level { terminal, toolCallId }, or nested in .data / .value
      let event: MetadataEvent;
      if (
        typeof o.type === "string" &&
        o.type.startsWith("data-") &&
        o.data !== undefined
      ) {
        event = {
          type: o.type as MetadataEvent["type"],
          data: o.data,
        } as MetadataEvent;
      } else if ("terminal" in o && "toolCallId" in o && !o.type) {
        event = {
          type: "data-terminal",
          data: o as { terminal: string; toolCallId: string },
        };
      } else if (
        o.data &&
        typeof o.data === "object" &&
        "terminal" in (o.data as object) &&
        "toolCallId" in (o.data as object)
      ) {
        event = {
          type: "data-terminal",
          data: o.data as { terminal: string; toolCallId: string },
        };
      } else if (
        o.value &&
        typeof o.value === "object" &&
        "terminal" in (o.value as object) &&
        "toolCallId" in (o.value as object)
      ) {
        event = {
          type: "data-terminal",
          data: o.value as Record<string, unknown> as {
            terminal: string;
            toolCallId: string;
          },
        };
      } else {
        event = o as MetadataEvent;
      }
      // Only store events needed by useAutoResume (avoids unbounded growth)
      if (event.type === "data-appendMessage") {
        setDataStream((ds) => (ds ? [...ds, event] : []));
      }
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
        const parsed = parseRateLimitWarning(rawData, {
          hasUserDismissed: hasUserDismissedWarningRef.current,
        });
        if (parsed) setRateLimitWarning(parsed);
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
      if (event.type === "data-terminal") {
        const d = event.data as { terminal: string; toolCallId: string };
        terminalPartsRef.current.push({
          type: "data-terminal",
          id: `trigger-terminal-${++terminalPartCounterRef.current}`,
          data: d,
        } as ChatMessage["parts"][0]);
        setTerminalDataGeneration((g) => g + 1);
      }
    },
  });
  const { run: triggerRunStatus } = useRealtimeRun(
    triggerRun?.runId ?? undefined,
    {
      accessToken: triggerRun?.publicAccessToken ?? "",
      enabled: enabled && !!triggerRun,
    },
  );

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

  // Clear active_trigger_run_id in Convex when run ends (COMPLETED/FAILED/CANCELED)
  useEffect(() => {
    if (!triggerRun) return;
    const runStatus = triggerRunStatus?.status;
    if (
      runStatus === "COMPLETED" ||
      runStatus === "FAILED" ||
      runStatus === "CANCELED"
    ) {
      clearActiveTriggerRunIdMutation({ chatId }).catch(() => {});
      if (runStatus === "FAILED" || runStatus === "CANCELED") {
        setTriggerRun(null);
        setTriggerBaseAndUserMessages([]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("ready");
        terminalPartsRef.current = [];
        terminalPartCounterRef.current = 0;
      }
    }
  }, [
    triggerRun,
    triggerRunStatus?.status,
    chatId,
    clearActiveTriggerRunIdMutation,
  ]);

  // Robust in-repo accumulator: UIMessageChunk[] → ChatMessage (no ReadableStream / readUIMessageStream)
  // Run update immediately so terminal data streams incrementally (no throttle that resets on each chunk)
  // Cache accumulated message when only terminalDataGeneration changes to avoid re-accumulating all AI chunks.
  useEffect(() => {
    if (!triggerRun) {
      setTriggerAssistantMessage(null);
      cachedAccumulatedMsgRef.current = null;
      return;
    }
    if (aiParts.length === 0) {
      setTriggerAssistantMessage(null);
      cachedAccumulatedMsgRef.current = null;
      return;
    }

    const generation = ++aiPartsGenerationRef.current;
    const messageId = `trigger-${triggerRun.runId}`;

    const update = () => {
      if (generation !== aiPartsGenerationRef.current) return;
      try {
        let msg: ChatMessage;
        if (
          aiParts === cachedAiPartsRef.current &&
          cachedAccumulatedMsgRef.current
        ) {
          msg = cachedAccumulatedMsgRef.current;
        } else {
          msg = accumulateChunksToMessage(
            aiParts as import("ai").UIMessageChunk[],
            messageId,
          );
          cachedAccumulatedMsgRef.current = msg;
          cachedAiPartsRef.current = aiParts;
        }
        // Inject terminal data parts from metadata stream for live streaming display.
        // Avoid triple spread: reuse msg.parts when no terminal parts; otherwise one concat.
        const terminalParts = terminalPartsRef.current;
        const parts =
          terminalParts.length > 0
            ? ((msg.parts?.length
                ? [...msg.parts, ...terminalParts]
                : terminalParts.slice()) as ChatMessage["parts"])
            : msg.parts;
        const nextMessage = { ...msg, parts };
        setTriggerAssistantMessage(nextMessage);
      } catch (err) {
        console.error("Chunk accumulation error:", err);
        if (generation === aiPartsGenerationRef.current) {
          setTriggerAssistantMessage(null);
        }
      }
    };

    update();
  }, [triggerRun, aiParts, terminalDataGeneration]);

  useEffect(() => {
    if (!triggerRun || triggerStatus !== "ready") return;

    // Don't commit empty messages during reconnect -- backfill hasn't arrived yet
    if (reconnectRunId && triggerBaseAndUserMessages.length === 0) {
      setTriggerRun(null);
      setTriggerBaseAndUserMessages([]);
      setTriggerAssistantMessage(null);
      setTriggerStatus("ready");
      setIsAutoResuming(false);
      setAwaitingServerChat(false);
      // Do NOT set skipPaginatedSyncUntilRef -- let sync run immediately
      return;
    }

    skipPaginatedSyncUntilRef.current = Date.now() + 3000;

    // Use accumulated message from current aiParts when committing so we don't miss final chunks
    const assistantMessage =
      aiParts.length > 0
        ? accumulateChunksToMessage(
            aiParts as import("ai").UIMessageChunk[],
            `trigger-${triggerRun.runId}`,
          )
        : triggerAssistantMessage;

    const fullMessages = [
      ...triggerBaseAndUserMessages,
      ...(assistantMessage ? [assistantMessage] : []),
    ];
    setMessages(fullMessages);

    const assistantMsg = assistantMessage ?? triggerAssistantMessage;
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
    terminalPartsRef.current = [];
    terminalPartCounterRef.current = 0;

    if (!isExistingChatRef.current) {
      onRunComplete?.({ chatId });
    }
    reconnectedForRef.current = null;
  }, [
    triggerRun,
    triggerStatus,
    triggerBaseAndUserMessages,
    triggerAssistantMessage,
    aiParts,
    reconnectRunId,
    setMessages,
    chatId,
    isExistingChatRef,
    setUploadStatus,
    setSummarizationStatus,
    setIsAutoResuming,
    setAwaitingServerChat,
    onRunComplete,
  ]);

  const submit = useCallback(
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
      const { v4: uuidv4 } = await import("uuid");
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
        const res = await fetchWithErrorHandlers("/api/agent-long", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            messages: stripUrls(fullMessages),
            mode: "agent-long",
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
        skipPaginatedSyncUntilRef.current = 0;
        setTriggerRun({ runId, publicAccessToken });
        setTriggerBaseAndUserMessages(fullMessages as ChatMessage[]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("streaming");
        setActiveTriggerRunIdMutation({ chatId, runId }).catch(() => {});
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to start agent");
      }
    },
    [messages, chatId, todos, sandboxPreference, setActiveTriggerRunIdMutation],
  );

  const regenerate = useCallback(
    async (opts?: {
      body?: { todos?: Todo[]; sandboxPreference?: string };
    }) => {
      const cleanedTodos = opts?.body?.todos ?? todos;
      const pref = opts?.body?.sandboxPreference ?? sandboxPreference;
      try {
        const res = await fetchWithErrorHandlers("/api/agent-long", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            messages: [],
            mode: "agent-long",
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
        skipPaginatedSyncUntilRef.current = 0;
        setTriggerRun({ runId, publicAccessToken });
        setTriggerBaseAndUserMessages(messages.slice(0, -1) as ChatMessage[]);
        setTriggerAssistantMessage(null);
        setTriggerStatus("streaming");
        setActiveTriggerRunIdMutation({ chatId, runId }).catch(() => {});
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to regenerate");
      }
    },
    [messages, chatId, todos, sandboxPreference, setActiveTriggerRunIdMutation],
  );

  const cancel = useCallback(async () => {
    if (!triggerRun) return;
    const runIdToCancel = triggerRun.runId;
    const chatIdToCancel = chatId;
    clearActiveTriggerRunIdMutation({ chatId: chatIdToCancel }).catch(() => {});
    setTriggerRun(null);
    setTriggerBaseAndUserMessages([]);
    setTriggerAssistantMessage(null);
    setTriggerStatus("ready");
    terminalPartsRef.current = [];
    terminalPartCounterRef.current = 0;
    fetch("/api/agent-long/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: runIdToCancel,
        chatId: chatIdToCancel,
      }),
    }).catch(() => {});
  }, [triggerRun, chatId, clearActiveTriggerRunIdMutation]);

  const reset = useCallback(() => {
    setTriggerRun(null);
    setTriggerBaseAndUserMessages([]);
    setTriggerAssistantMessage(null);
    setTriggerStatus("ready");
    lastTriggerAssistantIdRef.current = null;
    terminalPartsRef.current = [];
    terminalPartCounterRef.current = 0;
  }, []);

  const displayMessages =
    triggerRun !== null
      ? [
          ...triggerBaseAndUserMessages,
          ...(triggerAssistantMessage ? [triggerAssistantMessage] : []),
        ]
      : messages; // Return parent messages instead of empty array to prevent UI flash

  return {
    isActive: triggerRun !== null,
    status: triggerStatus,
    displayMessages,
    submit,
    regenerate,
    cancel,
    reset,
    skipPaginatedSyncUntilRef,
    lastTriggerAssistantIdRef,
  };
}
