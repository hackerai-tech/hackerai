import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import type {
  AgentPermissionMode,
  ChatMessage,
  ChatMode,
  SandboxPreference,
  SelectedModel,
} from "@/types";

const mockRegenerate = jest.fn();
const mockSendMessage = jest.fn();
const mockSetMessages = jest.fn();
const mockSetTodos = jest.fn();
const mockSetIsAutoResuming = jest.fn();
const mockCaptureAuthenticatedEvent = jest.fn();
const mockCaptureCancellationEvent = jest.fn();
const mockToastInfo = jest.fn();
const mockMutation = jest.fn(
  async (_args: Record<string, unknown>): Promise<unknown> => undefined,
);
let mockSelectedModel: SelectedModel = "hackerai-standard";
let mockChatMode: ChatMode = "ask";
let mockSandboxPreference: SandboxPreference = "e2b";
let mockAgentPermissionMode: AgentPermissionMode = "ask_approval";
let mockDesktopEnvironmentId: string | undefined;
const originalFetch = globalThis.fetch;

jest.mock("convex/react", () => ({
  useMutation: () => mockMutation,
}));

const mockUploadedFiles: never[] = [];

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    getInput: () => "",
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: mockChatMode,
    clearInput: jest.fn(),
    clearUploadedFiles: jest.fn(),
    todos: [],
    setTodos: mockSetTodos,
    isUploadingFiles: false,
    subscription: "pro",
    queueMessage: jest.fn(),
    messageQueue: [],
    removeQueuedMessage: jest.fn(),
    queueBehavior: "queue",
    sandboxPreference: mockSandboxPreference,
    desktopEnvironmentId: mockDesktopEnvironmentId,
    agentPermissionMode: mockAgentPermissionMode,
    selectedModel: mockSelectedModel,
  }),
}));

jest.mock("@/app/components/DataStreamProvider", () => ({
  useDataStreamDispatch: () => ({
    setIsAutoResuming: mockSetIsAutoResuming,
  }),
}));

jest.mock("@/lib/analytics/client", () => {
  const { sanitizeAgentCancellationEvent } = jest.requireActual<
    typeof import("@/lib/analytics/agent-cancellation-privacy")
  >("@/lib/analytics/agent-cancellation-privacy");
  return {
    getIdentifiedAnalyticsUserId: () => "test-user",
    // Deliver through the privacy filter PostHog's before_send applies after
    // SDK enrichment, so assertions see what would actually leave the browser.
    captureQueuedAuthenticatedEvent: ({
      event,
      properties,
    }: {
      event: string;
      properties: Record<string, unknown>;
    }) =>
      mockCaptureCancellationEvent(
        sanitizeAgentCancellationEvent({
          event,
          properties: {
            ...properties,
            token: "phc_test",
            distinct_id: "test-user",
            $current_url: "https://hackerai.co/c/chat-1?q=CANARY",
            prompt: "CANARY",
          },
          $set: { email: "CANARY@example.com" },
        }),
      ),
    captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
  };
});

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    info: mockToastInfo,
  },
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => false,
}));

const { useChatHandlers } =
  require("../useChatHandlers") as typeof import("../useChatHandlers");
const { getCancellationResponseReceipt } =
  require("@/lib/agent-cancellation-response") as typeof import("@/lib/agent-cancellation-response");

const messages = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Question" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Old answer" }],
  },
] as ChatMessage[];

describe("useChatHandlers regenerate model", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedModel = "hackerai-standard";
    mockChatMode = "ask";
  });

  afterEach(() => {
    if (originalFetch) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
      });
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it.each(["handleStop", "handleRegenerate", "handleRetry"] as const)(
    "%s works without Array.findLast and preserves message order",
    async (handler) => {
      const history = [
        ...messages,
        { id: "user-2", role: "user", parts: [] },
        { id: "assistant-2", role: "assistant", parts: [] },
        { id: "system-1", role: "system", parts: [] },
      ] as ChatMessage[];
      const originalIds = history.map((message) => message.id);
      const stop = jest.fn();
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages: history,
          sendMessage: mockSendMessage,
          stop,
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: false,
          status: "ready",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      const descriptor = Object.getOwnPropertyDescriptor(
        Array.prototype,
        "findLast",
      )!;
      Object.defineProperty(Array.prototype, "findLast", {
        ...descriptor,
        value: undefined,
      });
      try {
        await act(async () => {
          await result.current[handler]();
        });
      } finally {
        Object.defineProperty(Array.prototype, "findLast", descriptor);
      }

      expect(history.map((message) => message.id)).toEqual(originalIds);
      if (handler === "handleStop") {
        expect(stop).toHaveBeenCalledTimes(1);
      } else {
        expect(mockRegenerate).toHaveBeenCalledTimes(1);
        expect(mockSetMessages).toHaveBeenCalledWith(history.slice(0, 3));
      }
      if (handler !== "handleRetry") {
        expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
          handler === "handleStop"
            ? "chat_response_stop_requested"
            : "chat_response_regeneration_requested",
          expect.objectContaining({ message_id: "assistant-2" }),
        );
      }
    },
  );

  it("uses the latest chat input model from a previously rendered regenerate callback", async () => {
    const { result, rerender } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: false,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    const regenerateFromRenderedMessage = result.current.handleRegenerate;

    mockSelectedModel = "hackerai-max";
    rerender();

    await act(async () => {
      await regenerateFromRenderedMessage();
    });

    expect(mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ selectedModel: "hackerai-max" }),
      }),
    );
  });

  it("uses the latest chat input model from a previously rendered continue callback", () => {
    const { result, rerender } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: false,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    const continueFromRenderedMessage = result.current.handleContinue;

    mockSelectedModel = "hackerai-max";
    rerender();

    act(() => {
      continueFromRenderedMessage();
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        body: expect.objectContaining({ selectedModel: "hackerai-max" }),
      }),
    );
  });

  it("passes explicit allowance consent when continuing saved work", async () => {
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await result.current.handleContinue("auto", {
        type: "paid_daily_free_allowance",
      });
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { isAutoContinue: true } }),
      expect.objectContaining({
        body: expect.objectContaining({
          selectedModel: "auto",
          limitRescue: { type: "paid_daily_free_allowance" },
          isAutoContinue: true,
        }),
      }),
    );
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
  });

  it("uses a fresh request identity for each regeneration attempt", async () => {
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );

    await act(async () => {
      await result.current.handleRegenerate();
      await result.current.handleRegenerate();
    });

    const firstRequestId = mockRegenerate.mock.calls[0]?.[0]?.body
      ?.agentRunRequestId as string;
    const secondRequestId = mockRegenerate.mock.calls[1]?.[0]?.body
      ?.agentRunRequestId as string;
    expect(firstRequestId).toEqual(expect.any(String));
    expect(secondRequestId).toEqual(expect.any(String));
    expect(secondRequestId).not.toBe(firstRequestId);
  });

  it.each([
    ["handleStop", "stop"],
    ["handleRegenerate", "regenerate"],
    ["handleRetry", "retry"],
    ["handleEditMessage", "edit"],
  ] as const)(
    "tracks %s against the captured run without changing cancellation",
    async (handler, action) => {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: jest.fn(async () => ({ ok: true, status: 200 }) as Response),
      });
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: "run-1" },
        }),
      );
      await act(async () => {
        if (handler === "handleEditMessage")
          await result.current.handleEditMessage("user-1", "edited");
        else await result.current[handler]();
      });
      expect(mockCaptureCancellationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "agent_run_cancellation_requested",
          properties: expect.objectContaining({
            action,
            triggerRunId: "run-1",
            reason: action === "stop" ? "stop" : "replace",
          }),
        }),
      );
      expect(mockCaptureCancellationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "agent_run_cancellation_settled",
          properties: expect.objectContaining({
            action,
            triggerRunId: "run-1",
            outcome: "accepted",
          }),
        }),
      );
    },
  );

  it("cancels the active Trigger session before regenerating", async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, status: 200 }) as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "run-1",
        }),
      }),
    );
    expect(mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agentRunRequestId: expect.any(String),
        }),
      }),
    );
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegenerate.mock.invocationCallOrder[0],
    );
  });

  it("cancels the active Trigger session before regenerating an edited message", async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, status: 200 }) as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    await act(async () => {
      await result.current.handleEditMessage("user-1", "Edited question");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "run-1",
        }),
      }),
    );
    expect(mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          regenerate: true,
          agentRunRequestId: expect.any(String),
        }),
      }),
    );
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegenerate.mock.invocationCallOrder[0],
    );
  });

  it("rejects editing an older user message before cancelling or regenerating", async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, status: 200 }) as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const multiTurnMessages = [
      messages[0],
      messages[1],
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Follow-up question" }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "Follow-up answer" }],
      },
    ] as ChatMessage[];
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: multiTurnMessages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    await act(async () => {
      await result.current.handleEditMessage("user-1", "Edited question");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
  });

  it("cancels a restored Trigger run even when the current mode is ask", async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, status: 204 }) as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const stop = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [],
        sendMessage: mockSendMessage,
        stop,
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    let stopped: boolean | undefined;
    await act(async () => {
      stopped = await result.current.handleStop();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "run-1",
        }),
      }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(true);
  });

  it("reports a terminal cancellation rejection to approval UI callers", async () => {
    const readBody = jest.fn();
    const headerGet = jest.fn((name: string) =>
      name === "x-vercel-id"
        ? "iad1::iad1::abcd1-1763049600000-0123456789abcdef"
        : "session=CANARY",
    );
    const fetchMock = jest.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          type: "basic",
          redirected: false,
          url: "https://hackerai.co/api/agent/cancel?token=CANARY",
          headers: { get: headerGet },
          json: readBody,
          text: readBody,
        }) as unknown as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const stop = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [],
        sendMessage: mockSendMessage,
        stop,
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    let stopped: boolean | undefined;
    let errorLogs: unknown[][];
    try {
      await act(async () => {
        stopped = await result.current.handleStop();
      });
    } finally {
      errorLogs = [...logged.mock.calls];
      logged.mockRestore();
    }

    expect(stopped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(headerGet.mock.calls).toEqual([["x-vercel-id"]]);
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    // The caller still sees the service's original rejection object.
    const [, rejection] = errorLogs.find(
      ([message]) => message === "Failed to cancel trigger.dev run:",
    )!;
    expect(rejection).toEqual(
      new Error("Agent cancellation failed with status 403"),
    );
    const receipt = {
      cancellation_response_diagnostic_version: 1,
      cancellation_response_http_status: 403,
      cancellation_response_type: "basic",
      cancellation_response_redirected: "false",
      cancellation_response_url_origin: "hackerai_production",
      cancellation_response_endpoint: "agent_cancel",
      cancellation_response_platform_request_id_state: "valid",
      cancellation_response_platform_request_id:
        "iad1::iad1::abcd1-1763049600000-0123456789abcdef",
    };
    expect(getCancellationResponseReceipt(rejection)).toEqual(receipt);
    const delivered = mockCaptureCancellationEvent.mock.calls.map(
      ([event]) => event as { event: string; properties: object },
    );
    const requested = delivered.filter(
      ({ event }) => event === "agent_run_cancellation_requested",
    );
    const settled = delivered.filter(
      ({ event }) => event === "agent_run_cancellation_settled",
    );
    expect(requested).toHaveLength(1);
    expect(settled).toEqual([
      {
        event: "agent_run_cancellation_settled",
        properties: {
          ...requested[0].properties,
          outcome: "error",
          durationMs: expect.any(Number),
          ...receipt,
        },
      },
    ]);
    expect(requested[0].properties).toMatchObject({
      schemaVersion: 1,
      action: "stop",
      triggerRunId: "run-1",
    });
    expect(JSON.stringify(delivered)).not.toContain("CANARY");
  });

  it("reconnects to the persisted run after a stale cancellation", async () => {
    const fetchMock = jest.fn(async () => {
      return {
        ok: false,
        status: 409,
        json: jest.fn(async () => ({
          canceled: false,
          reason: "stale_run",
          activeTriggerRunId: "run-2",
        })),
      } as unknown as Response;
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    const activeTriggerRunRef = { current: "run-1" };
    const hasManuallyStoppedRef = { current: false };
    const resumeActiveRun = jest.fn(async () => undefined);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [],
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef,
        activeTriggerRunRef,
        resumeActiveRun,
      }),
    );

    let stopped: boolean | undefined;
    await act(async () => {
      stopped = await result.current.handleStop();
    });

    expect(stopped).toBe(false);
    expect(activeTriggerRunRef.current).toBe("run-2");
    expect(hasManuallyStoppedRef.current).toBe(false);
    expect(resumeActiveRun).toHaveBeenCalledTimes(1);
    expect(mockSetIsAutoResuming).toHaveBeenLastCalledWith(true);
    expect(mockToastInfo).toHaveBeenCalledWith("Agent run changed", {
      description: "Reconnecting to the current run instead of cancelling it.",
    });
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "agent_cancel_stale_recovery_started",
      {
        chat_id: "chat-1",
        expected_trigger_run_id: "run-1",
        active_trigger_run_id: "run-2",
        recovery_action: "resume_stream",
        cancellation_applied: false,
      },
    );
  });

  it("clears an obsolete run without resuming when none is active", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async () => {
        return {
          ok: false,
          status: 409,
          json: jest.fn(async () => ({
            canceled: false,
            reason: "stale_run",
            activeTriggerRunId: null,
          })),
        } as unknown as Response;
      }),
    });
    const activeTriggerRunRef: { current: string | undefined } = {
      current: "run-1",
    };
    const resumeActiveRun = jest.fn(async () => undefined);
    const onAgentRunAlreadyFinished = jest.fn();
    const getAgentRunRequestGeneration = jest.fn(() => 7);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [],
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef,
        resumeActiveRun,
        getAgentRunRequestGeneration,
        onAgentRunAlreadyFinished,
      }),
    );

    let stopped: boolean | undefined;
    await act(async () => {
      stopped = await result.current.handleStop();
    });

    expect(stopped).toBe(false);
    expect(activeTriggerRunRef.current).toBeUndefined();
    expect(resumeActiveRun).not.toHaveBeenCalled();
    expect(mockSetIsAutoResuming).toHaveBeenLastCalledWith(false);
    expect(getAgentRunRequestGeneration).toHaveBeenCalledTimes(1);
    expect(onAgentRunAlreadyFinished).toHaveBeenCalledWith("run-1", 7);
    expect(mockToastInfo).not.toHaveBeenCalled();
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "agent_cancel_stale_recovery_started",
      {
        chat_id: "chat-1",
        expected_trigger_run_id: "run-1",
        active_trigger_run_id: null,
        recovery_action: "no_active_run",
        cancellation_applied: false,
      },
    );
  });
});

describe("replacement request ownership across awaited work", () => {
  type MutationArgs = Record<string, unknown>;
  type Handlers = ReturnType<typeof useChatHandlers>;

  const replacements = {
    Regenerate: (handlers: Handlers) => handlers.handleRegenerate(),
    Retry: (handlers: Handlers) => handlers.handleRetry(),
    Edit: (handlers: Handlers) =>
      handlers.handleEditMessage("user-1", "Edited question"),
  };
  const awaitedSteps = {
    "the saved-request check": { status: "ready" },
    "stream cancellation": {
      status: "streaming",
      matches: (args: MutationArgs) => args.skipSave === true,
    },
    "response deletion": {
      status: "ready",
      matches: (args: MutationArgs) => args.resetSummary === true,
    },
    "the edit save": {
      status: "ready",
      matches: (args: MutationArgs) => args.newContent !== undefined,
    },
  } as const;
  type AwaitedStep = keyof typeof awaitedSteps;

  const resetSelection = () => {
    mockSelectedModel = "hackerai-standard";
    mockChatMode = "ask";
    mockSandboxPreference = "e2b";
    mockAgentPermissionMode = "ask_approval";
    mockDesktopEnvironmentId = undefined;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetSelection();
    mockMutation.mockImplementation(async () => undefined);
  });
  afterEach(() => {
    resetSelection();
    if (originalFetch) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
      });
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  /** Renders chat-1 with one awaited step held open until `release`. */
  const renderHeldChat = (step: AwaitedStep) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const awaited = awaitedSteps[step];
    const isUserMessagePersisted = jest.fn(async (_messageId: string) => {
      if (step === "the saved-request check") await held;
      return true;
    });
    if ("matches" in awaited) {
      mockMutation.mockImplementation(async (args) => {
        if (awaited.matches(args)) await held;
        return undefined;
      });
    }
    const view = renderHook(
      ({ chatId }: { chatId: string }) =>
        useChatHandlers({
          chatId,
          messages: chatId === "chat-1" ? messages : [],
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: true,
          isUserMessagePersisted,
          status: awaited.status,
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      { initialProps: { chatId: "chat-1" } },
    );
    const isHeld = () =>
      "matches" in awaited
        ? mockMutation.mock.calls.some(([args]) => awaited.matches(args))
        : isUserMessagePersisted.mock.calls.length > 0;
    return { ...view, release, isHeld };
  };

  it.each([
    ["Regenerate", "stream cancellation"],
    ["Retry", "the saved-request check"],
    ["Edit", "stream cancellation"],
  ] as const)(
    "%s from an older rendered message keeps the settings at invocation through %s",
    async (replacement, step) => {
      const chat = renderHeldChat(step);
      const renderedMessageHandlers = chat.result.current;
      mockSelectedModel = "hackerai-max";
      mockSandboxPreference = "desktop";
      mockAgentPermissionMode = "full_access";
      chat.rerender({ chatId: "chat-1" });

      let action!: Promise<void>;
      await act(async () => {
        action = replacements[replacement](renderedMessageHandlers);
      });
      expect(chat.isHeld()).toBe(true);
      expect(mockRegenerate).not.toHaveBeenCalled();

      // A later selection belongs to the next request, not this one.
      mockSelectedModel = "hackerai-pro";
      mockChatMode = "agent";
      mockSandboxPreference = "e2b";
      mockAgentPermissionMode = "auto_review";
      chat.rerender({ chatId: "chat-1" });
      await act(async () => {
        chat.release();
        await action;
      });

      expect(mockRegenerate).toHaveBeenCalledTimes(1);
      expect(mockRegenerate).toHaveBeenCalledWith({
        body: expect.objectContaining({
          mode: "ask",
          selectedModel: "hackerai-max",
          sandboxPreference: "desktop",
          agentPermissionMode: "full_access",
        }),
      });
    },
  );

  it("keeps an explicit Retry model ahead of the current selection", async () => {
    const chat = renderHeldChat("the saved-request check");
    chat.release();
    mockSelectedModel = "hackerai-max";
    chat.rerender({ chatId: "chat-1" });

    await act(async () => {
      await chat.result.current.handleRetry({ selectedModel: "auto" });
    });

    expect(mockRegenerate).toHaveBeenCalledWith({
      body: expect.objectContaining({ selectedModel: "auto" }),
    });
  });

  it.each([
    ["Regenerate", "stream cancellation", "is left and reopened"],
    ["Regenerate", "response deletion", "is left and reopened"],
    ["Regenerate", "response deletion", "unmounts"],
    ["Retry", "the saved-request check", "is left and reopened"],
    ["Retry", "stream cancellation", "is left and reopened"],
    ["Retry", "response deletion", "is left and reopened"],
    ["Edit", "stream cancellation", "is left and reopened"],
    ["Edit", "the edit save", "is left and reopened"],
  ] as const)(
    "%s abandons later work held at %s when the chat %s",
    async (replacement, step, departure) => {
      const chat = renderHeldChat(step);

      let action!: Promise<void>;
      await act(async () => {
        action = replacements[replacement](chat.result.current);
      });
      expect(chat.isHeld()).toBe(true);
      const mutationsIssued = mockMutation.mock.calls.length;
      const transcriptWrites = mockSetMessages.mock.calls.length;
      const todoWrites = mockSetTodos.mock.calls.length;

      if (departure === "unmounts") {
        chat.unmount();
      } else {
        // Returning to the same chat must not revive the earlier visit's action.
        chat.rerender({ chatId: "chat-2" });
        chat.rerender({ chatId: "chat-1" });
      }
      await act(async () => {
        chat.release();
        await action;
      });

      // Work already issued for the original chat is not rolled back, but no
      // new mutation, transcript/todo write or generation follows it.
      expect(mockRegenerate).not.toHaveBeenCalled();
      expect(mockMutation).toHaveBeenCalledTimes(mutationsIssued);
      expect(mockSetMessages).toHaveBeenCalledTimes(transcriptWrites);
      expect(mockSetTodos).toHaveBeenCalledTimes(todoWrites);
    },
  );

  it("Edit does not stop the stream after sending is disabled during a goal pause", async () => {
    mockChatMode = "agent";
    let releasePause!: () => void;
    const pauseHeld = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") await pauseHeld;
        return {
          ok: true,
          json: async () =>
            init?.method === "POST"
              ? { state: "paused" }
              : { goal: { generation: 4 } },
        } as Response;
      }),
    });
    const goalMessages = messages.map((message) =>
      message.id === "user-1"
        ? { ...message, metadata: { goal: { sent: true } } }
        : message,
    ) as ChatMessage[];
    const { result, rerender } = renderHook(
      ({ sendDisabledReason }: { sendDisabledReason?: string }) =>
        useChatHandlers({
          chatId: "chat-1",
          messages: goalMessages,
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          goalState: "running",
          goalGeneration: 4,
          sendDisabledReason,
        }),
      { initialProps: {} },
    );

    let action!: Promise<void>;
    await act(async () => {
      action = result.current.handleEditMessage("user-1", "Updated goal");
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agent-goal",
      expect.objectContaining({ method: "POST" }),
    );
    rerender({ sendDisabledReason: "Computer disconnected" });
    await act(async () => {
      releasePause();
      await action;
    });

    expect(mockSetIsAutoResuming).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it.each([
    ["Regenerate", "response deletion"],
    ["Edit", "the edit save"],
  ] as const)(
    "%s started by a later layout callback after a chat change keeps ownership through %s",
    async (replacement, step) => {
      const { matches } = awaitedSteps[step];
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      mockMutation.mockImplementation(async (args) => {
        if (matches(args)) await held;
        return undefined;
      });
      let started: Promise<void> | undefined;
      const { rerender } = renderHook(
        ({ chatId }: { chatId: string }) => {
          const handlers = useChatHandlers({
            chatId,
            messages,
            sendMessage: mockSendMessage,
            stop: jest.fn(),
            regenerate: mockRegenerate,
            setMessages: mockSetMessages,
            isExistingChat: true,
            status: "ready",
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
          });
          // Runs during the commit that switches chats, before passive effects.
          useLayoutEffect(() => {
            if (chatId === "chat-2" && !started)
              started = replacements[replacement](handlers);
          }, [chatId, handlers]);
          return handlers;
        },
        { initialProps: { chatId: "chat-1" } },
      );

      rerender({ chatId: "chat-2" });
      expect(mockMutation.mock.calls.some(([args]) => matches(args))).toBe(
        true,
      );
      await act(async () => {
        releaseHeld();
        await started;
      });

      expect(mockRegenerate).toHaveBeenCalledTimes(1);
    },
  );

  it("an Agent Retry started by a later layout callback uses the settings committed with it", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async () => ({ status: 204 }) as Response),
    });
    let started: Promise<void> | undefined;
    const { rerender } = renderHook(
      ({ selection }: { selection: "initial" | "changed" }) => {
        const handlers = useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "error",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        });
        // Runs during the commit that applies the new settings, before
        // passive effects.
        useLayoutEffect(() => {
          if (selection === "changed" && !started)
            started = handlers.handleRetry();
        }, [selection, handlers]);
        return handlers;
      },
      { initialProps: { selection: "initial" as "initial" | "changed" } },
    );

    mockChatMode = "agent";
    mockSelectedModel = "hackerai-max";
    mockSandboxPreference = "desktop";
    mockDesktopEnvironmentId = "env-1";
    mockAgentPermissionMode = "full_access";
    rerender({ selection: "changed" });
    await act(async () => {
      await started;
    });

    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { isAutoContinue: true } }),
      {
        body: expect.objectContaining({
          mode: "agent",
          selectedModel: "hackerai-max",
          sandboxPreference: "desktop",
          desktopEnvironmentId: "env-1",
          agentPermissionMode: "full_access",
        }),
      },
    );
  });

  describe("Agent Retry delegated to saved-task recovery", () => {
    type RecoveryStep = "the run check" | "the recovery save";

    /** Renders an Agent chat whose saved-task recovery is held at `step`. */
    const renderHeldRecovery = (step: RecoveryStep) => {
      mockChatMode = "agent";
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runCheck = jest.fn(async () => {
        if (step === "the run check") await held;
        return { status: 204 } as Response;
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: runCheck,
      });
      const prepareAgentRecovery = jest.fn(async () => {
        if (step === "the recovery save") await held;
        return false;
      });
      const view = renderHook(
        ({ chatId }: { chatId: string }) =>
          useChatHandlers({
            chatId,
            messages,
            sendMessage: mockSendMessage,
            stop: jest.fn(),
            regenerate: mockRegenerate,
            setMessages: mockSetMessages,
            isExistingChat: true,
            status: "error",
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
            prepareAgentRecovery,
          }),
        { initialProps: { chatId: "chat-1" } },
      );
      const isHeld = () =>
        (step === "the run check" ? runCheck : prepareAgentRecovery).mock.calls
          .length > 0;
      return { ...view, release, isHeld, prepareAgentRecovery };
    };

    it.each(["the run check", "the recovery save"] as const)(
      "keeps the settings from an older rendered Retry through %s",
      async (step) => {
        const chat = renderHeldRecovery(step);
        const renderedMessageHandlers = chat.result.current;
        mockSelectedModel = "hackerai-max";
        mockSandboxPreference = "desktop";
        mockDesktopEnvironmentId = "env-1";
        mockAgentPermissionMode = "full_access";
        chat.rerender({ chatId: "chat-1" });

        let action!: Promise<void>;
        await act(async () => {
          action = renderedMessageHandlers.handleRetry();
        });
        expect(chat.isHeld()).toBe(true);
        expect(mockSendMessage).not.toHaveBeenCalled();

        // A later selection belongs to the next request, not this one.
        mockSelectedModel = "hackerai-pro";
        mockChatMode = "ask";
        mockSandboxPreference = "e2b";
        mockDesktopEnvironmentId = "env-2";
        mockAgentPermissionMode = "auto_review";
        chat.rerender({ chatId: "chat-1" });
        await act(async () => {
          chat.release();
          await action;
        });

        expect(mockRegenerate).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: { isAutoContinue: true } }),
          {
            body: expect.objectContaining({
              isAutoContinue: true,
              mode: "agent",
              selectedModel: "hackerai-max",
              sandboxPreference: "desktop",
              desktopEnvironmentId: "env-1",
              agentPermissionMode: "full_access",
            }),
          },
        );
      },
    );

    it("abandons recovery when the chat is left and reopened during the run check", async () => {
      const chat = renderHeldRecovery("the run check");

      let action!: Promise<void>;
      await act(async () => {
        action = chat.result.current.handleRetry();
      });
      expect(chat.isHeld()).toBe(true);
      chat.rerender({ chatId: "chat-2" });
      chat.rerender({ chatId: "chat-1" });
      await act(async () => {
        chat.release();
        await action;
      });

      expect(chat.prepareAgentRecovery).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });
});

describe("failed local attachment admission", () => {
  const localMessages = [
    {
      id: "unsaved-user-turn",
      role: "user",
      parts: [
        { type: "text", text: "Read the attached fixtures" },
        ...["txt", "pdf", "docx"].map((extension) => ({
          type: "file",
          mediaType: "application/octet-stream",
          url: "",
          filename: `fixture.${extension}`,
          storage: "local-desktop",
          localAttachmentId: `local-${extension}`,
          localPath: `/fixtures/file.${extension}`,
        })),
      ],
    },
  ] as ChatMessage[];

  it.each([false, true])(
    "retries the original unpersisted turn with source paths (existing task: %s)",
    async (isExistingChat) => {
      mockRegenerate.mockClear();
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "staging-failure",
          messages: localMessages,
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat,
          isUserMessagePersisted: async () => false,
          status: "error",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      await act(async () => {
        await result.current.handleRetry();
      });
      expect(mockRegenerate).toHaveBeenCalledTimes(1);
      expect(mockRegenerate).toHaveBeenCalledWith({
        body: expect.objectContaining({
          regenerate: false,
          messages: localMessages,
          useClientMessagesForRegenerate: true,
        }),
      });
      expect(localMessages[0].id).toBe("unsaved-user-turn");
    },
  );

  it("does not alter or resubmit the turn when persistence cannot be checked", async () => {
    mockRegenerate.mockClear();
    mockSetMessages.mockClear();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "unknown-persistence",
        messages: localMessages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        isUserMessagePersisted: async () => {
          throw new Error("offline");
        },
        status: "error",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(require("sonner").toast.error).toHaveBeenCalledWith(
      "Could not check the saved request. Please retry.",
    );
  });

  it("admits only one retry through lookup and streaming, then releases the guard", async () => {
    mockRegenerate.mockClear();
    let resolveCheck!: (value: boolean) => void;
    let finishRun!: () => void;
    const check = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    mockRegenerate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "single-retry",
        messages: localMessages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        isUserMessagePersisted: check,
        status: "error",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.handleRetry();
      await result.current.handleRetry();
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(mockRegenerate).not.toHaveBeenCalled();
    await act(async () => {
      resolveCheck(false);
    });
    expect(mockRegenerate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRun();
      await first;
    });
    // A lookup failure must release the guard too, so the user can try again.
    check.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      await result.current.handleRetry();
    });
    check.mockImplementationOnce(async () => true);
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(mockRegenerate).toHaveBeenCalledTimes(2);
    expect(mockRegenerate).toHaveBeenLastCalledWith({
      body: expect.objectContaining({ regenerate: true }),
    });
  });

  it.each(["synchronous", "asynchronous"])(
    "catches %s action errors and releases the retry guard",
    async (failureKind) => {
      mockRegenerate.mockClear();
      const failure = new Error("stream unavailable");
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      mockRegenerate.mockImplementationOnce(() => {
        if (failureKind === "synchronous") throw failure;
        return Promise.reject(failure);
      });
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "failed-retry",
          messages: localMessages,
          sendMessage: mockSendMessage,
          stop: jest.fn(),
          regenerate: mockRegenerate,
          setMessages: mockSetMessages,
          isExistingChat: true,
          isUserMessagePersisted: async () => true,
          status: "error",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      try {
        await act(async () => {
          await expect(result.current.handleRetry()).resolves.toBeUndefined();
        });
        expect(logged).toHaveBeenCalledWith(
          "Failed to retry response:",
          failure,
        );
        await act(async () => {
          await result.current.handleRetry();
        });
        expect(mockRegenerate).toHaveBeenCalledTimes(2);
      } finally {
        logged.mockRestore();
      }
    },
  );

  it("keeps regeneration semantics once the same user turn is persisted", async () => {
    mockRegenerate.mockClear();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "accepted-task",
        messages: localMessages,
        sendMessage: mockSendMessage,
        stop: jest.fn(),
        regenerate: mockRegenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        isUserMessagePersisted: async () => true,
        status: "error",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(mockRegenerate).toHaveBeenCalledWith({
      body: expect.objectContaining({ regenerate: true }),
    });
  });
});
