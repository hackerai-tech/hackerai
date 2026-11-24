import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ChatMessage, QueuedMessage, QueueBehavior, Todo } from "@/types";
import { fetchAgentLongStream } from "@/lib/chat/agent-long-transport";
import { toast } from "sonner";
import { AgentReplyConflictError } from "@/lib/chat/agent-user-wait";
import { ConvexError } from "convex/values";

jest.mock("@/lib/utils/client-token-validation", () => ({
  ...jest.requireActual<typeof import("@/lib/utils/client-token-validation")>(
    "@/lib/utils/client-token-validation",
  ),
  getInputTokenLimitStatus: jest.fn(
    jest.requireActual<typeof import("@/lib/utils/client-token-validation")>(
      "@/lib/utils/client-token-validation",
    ).getInputTokenLimitStatus,
  ),
}));

const mockCaptureAuthenticatedEvent = jest.fn();
const mockCaptureCancellationEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => "test-user",
  captureQueuedAuthenticatedEvent: (...args: unknown[]) =>
    mockCaptureCancellationEvent(...args),
  captureAuthenticatedEvent: (...args: unknown[]) =>
    mockCaptureAuthenticatedEvent(...args),
}));

const mockCancelDesktopRunLocally = jest.fn(
  async (_chatId: string, _runId: string) => undefined,
);
jest.mock("@/app/services/desktop-command-cancellation", () => ({
  cancelDesktopRunLocally: (...args: [string, string]) =>
    mockCancelDesktopRunLocally(...args),
}));

const mockCancelStream = jest.fn<() => Promise<boolean | null>>(
  async () => null,
);
const mockMarkUserStopped = jest.fn<
  (args: {
    chatId: string;
    messageId: string;
    role: "user" | "assistant";
  }) => Promise<boolean>
>(async () => false);
const mockSaveAssistantMessage = jest.fn(async () => null);
const mockDeleteLastAssistantMessage = jest.fn(async () => null);
const mockRegenerateWithNewContent = jest.fn<
  () => Promise<null | { goalGeneration: number }>
>(async () => null);
const mockRemoveQueuedMessage = jest.fn();
const mockCreateAgentSteer = jest.fn<
  (args: {
    chatId: string;
    id: string;
    text: string;
    sentAt: number;
  }) => Promise<string>
>(async () => "pending");
let mockAgentSteeringEnabled = false;
const mockQueueMessage = jest.fn();
const mockSendMessage = jest.fn(async () => undefined);
const mockStop = jest.fn();
const mockSetMessages = jest.fn();
const mockSetTodos = jest.fn();
const mockClearInput = jest.fn();
const mockClearUploadedFiles = jest.fn();
const mockResetAutoContinueCount = jest.fn();
let mockInput = "";
let mockUploadedFiles: any[] = [];
let mockSandboxPreference = "e2b";
let mockChatMode = "agent";
let mockAgentPermissionMode = "full_access";
let mockQueueBehavior: QueueBehavior = "queue";
let mockMessageQueue: QueuedMessage[];
let mockQueuedDeliveryStatus: "failed" | undefined;

const todos: Todo[] = [
  {
    id: "todo-1",
    content: "Keep this task",
    status: "in_progress",
    sourceMessageId: "assistant-1",
  },
];
let mockCurrentTodos: unknown = todos;

jest.mock("@/convex/_generated/api", () => ({
  api: {
    chatStreams: {
      cancelStreamFromClient: "cancelStreamFromClient",
      markMessageUserStopped: "markMessageUserStopped",
    },
    agentSteers: { create: "createAgentSteer" },
    messages: {
      deleteLastAssistantMessage: "deleteLastAssistantMessage",
      regenerateWithNewContent: "regenerateWithNewContent",
      saveAssistantMessage: "saveAssistantMessage",
    },
  },
}));

jest.mock("convex/react", () => ({
  useMutation: (mutation: string) => {
    switch (mutation) {
      case "cancelStreamFromClient":
        return mockCancelStream;
      case "markMessageUserStopped":
        return mockMarkUserStopped;
      case "saveAssistantMessage":
        return mockSaveAssistantMessage;
      case "deleteLastAssistantMessage":
        return mockDeleteLastAssistantMessage;
      case "regenerateWithNewContent":
        return mockRegenerateWithNewContent;
      case "createAgentSteer":
        return mockCreateAgentSteer;
      default:
        throw new Error(`Unexpected mutation: ${mutation}`);
    }
  },
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    getInput: () => mockInput,
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: mockChatMode,
    clearInput: mockClearInput,
    clearUploadedFiles: mockClearUploadedFiles,
    todos: mockCurrentTodos,
    setTodos: mockSetTodos,
    isUploadingFiles: false,
    subscription: "pro",
    queueMessage: mockQueueMessage,
    messageQueue: mockMessageQueue.map((message) => ({
      ...message,
      deliveryStatus: message.deliveryStatus ?? mockQueuedDeliveryStatus,
    })),
    removeQueuedMessage: mockRemoveQueuedMessage,
    queueBehavior: mockQueueBehavior,
    agentSteeringEnabled: mockAgentSteeringEnabled,
    sandboxPreference: mockSandboxPreference,
    agentPermissionMode: mockAgentPermissionMode,
    selectedModel: "hackerai-standard",
    sidebarOpen: false,
    sidebarContent: null,
    openSidebar: jest.fn(),
    closeSidebar: jest.fn(),
  }),
}));

jest.mock("@/app/components/DataStreamProvider", () => ({
  useDataStreamDispatch: () => ({ setIsAutoResuming: jest.fn() }),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => false,
}));

const { useChatHandlers } =
  require("../useChatHandlers") as typeof import("../useChatHandlers");

const messages: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Start the task" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-todo_write",
        toolCallId: "todo-call-1",
        state: "output-available",
        input: { todos },
        output: { currentTodos: todos },
      },
    ],
  },
];

describe("useChatHandlers steer todo handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(
        require("@/lib/utils/client-token-validation").getInputTokenLimitStatus,
      )
      .mockImplementation(
        jest.requireActual<
          typeof import("@/lib/utils/client-token-validation")
        >("@/lib/utils/client-token-validation").getInputTokenLimitStatus,
      );
    mockQueueMessage.mockReset();
    mockQueueMessage.mockReturnValue("queued-1");
    mockInput = "";
    mockCurrentTodos = todos;
    mockUploadedFiles = [];
    mockSandboxPreference = "e2b";
    mockChatMode = "agent";
    mockAgentPermissionMode = "full_access";
    mockQueueBehavior = "queue";
    mockAgentSteeringEnabled = false;
    mockCreateAgentSteer.mockResolvedValue("pending");
    mockQueuedDeliveryStatus = undefined;
    mockMessageQueue = [
      { id: "queued-1", text: "Change direction", files: [], timestamp: 123 },
    ];
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(
        async (url: unknown) =>
          ({
            ok: true,
            status: String(url).includes("/resume?") ? 204 : 200,
          }) as Response,
      ),
    });
  });

  it.each([false, true])(
    "allows only the wait reply while the computer is disconnected (structured=%s)",
    async (structured) => {
      mockInput = structured ? "Unsent ordinary draft" : "/goal pause";
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          goalState: "needs_input",
          sendDisabledReason: "Reconnect your computer",
          activeTriggerRunRef: { current: "run-1" },
          pendingUserWait: {
            runId: "run-1",
            toolCallId: "tool-1",
            status: "waiting",
            published: true,
          },
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      await act(async () => result.current.handleSendNow("queued-1"));
      expect(mockCancelStream).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await act(async () => {
        expect(
          await result.current.handleSubmit(
            { preventDefault: jest.fn() } as any,
            structured ? "/goal pause" : undefined,
            structured,
          ),
        ).toBe(true);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent/reply",
        expect.objectContaining({
          body: JSON.stringify({
            chatId: "chat-1",
            runId: "run-1",
            toolCallId: "tool-1",
            waitWasPublished: true,
            text: "/goal pause",
          }),
        }),
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).toHaveBeenCalledTimes(structured ? 0 : 1);
    },
  );

  it.each([
    { status: 400, conflict: false },
    { status: 409, conflict: false },
    { status: 425, conflict: false },
    { status: 409, conflict: true },
  ])(
    "retains a rejected reply and permits resubmission after HTTP $status (conflict=$conflict)",
    async ({ status, conflict }) => {
      jest.useFakeTimers();
      const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
      try {
        mockInput = "Keep this answer";
        jest.mocked(global.fetch).mockResolvedValue({
          ok: false,
          status,
          ...(conflict
            ? { json: async () => ({ error: "reply_conflict" }) }
            : {}),
        } as Response);
        const { result } = renderHook(() =>
          useChatHandlers({
            chatId: "chat-1",
            messages,
            sendMessage: mockSendMessage,
            stop: mockStop,
            regenerate: jest.fn(),
            setMessages: mockSetMessages,
            isExistingChat: true,
            status: "streaming",
            pendingUserWait: {
              runId: "run-1",
              toolCallId: "tool-1",
              status: "waiting",
            },
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
          }),
        );
        let submission!: Promise<boolean | Error>;
        await act(async () => {
          submission = result.current
            .handleSubmit(
              { preventDefault: jest.fn() } as any,
              conflict ? mockInput : undefined,
              conflict,
            )
            .catch((error) => error);
          await jest.advanceTimersByTimeAsync(0);
        });
        if (status === 425) {
          for (const [index, delay] of [250, 500, 750].entries()) {
            expect(fetch).toHaveBeenCalledTimes(index + 1);
            await act(async () => {
              await jest.advanceTimersByTimeAsync(delay - 1);
            });
            expect(fetch).toHaveBeenCalledTimes(index + 1);
            await act(async () => {
              await jest.advanceTimersByTimeAsync(1);
            });
          }
        }
        if (conflict)
          expect(await submission).toBeInstanceOf(AgentReplyConflictError);
        else expect(await submission).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(status === 425 ? 4 : 1);
        expect(mockClearInput).not.toHaveBeenCalled();
        if (status === 409)
          expect(errorToast).toHaveBeenCalledWith(
            "Could not send your reply",
            expect.objectContaining({
              description: expect.stringContaining(
                conflict ? "Retry that same answer" : "This wait has ended",
              ),
            }),
          );
        jest
          .mocked(global.fetch)
          .mockResolvedValue({ ok: true, status: 200 } as Response);
        await act(async () => {
          expect(
            await result.current.handleSubmit({
              preventDefault: jest.fn(),
            } as any),
          ).toBe(true);
        });
        expect(mockClearInput).toHaveBeenCalledTimes(1);
      } finally {
        errorToast.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it.each(["rejected", "network", "success", "newer-stop"])(
    "preserves Stop intent across a %s wait reply",
    async (outcome) => {
      mockInput = "Beta";
      const hasManuallyStoppedRef = { current: true };
      let resolveReply!: (value: Response) => void;
      let rejectReply!: (error: Error) => void;
      jest.mocked(global.fetch).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            resolveReply = resolve;
            rejectReply = reject;
          }),
      );
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "ready",
          pendingUserWait: {
            runId: "run-1",
            toolCallId: "tool-1",
            status: "waiting",
          },
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef,
        }),
      );
      let submission!: Promise<boolean>;
      await act(async () => {
        submission = result.current.handleSubmit({
          preventDefault: jest.fn(),
        } as any);
      });
      expect(hasManuallyStoppedRef.current).toBe(true);
      if (outcome === "newer-stop") {
        await act(async () => {
          await result.current.handleStop();
        });
      }
      await act(async () => {
        if (outcome === "network") rejectReply(new Error("Connection lost"));
        else
          resolveReply({
            ok: outcome !== "rejected",
            status: outcome === "rejected" ? 500 : 200,
          } as Response);
        expect(await submission).toBe(
          outcome === "success" || outcome === "newer-stop",
        );
      });
      expect(hasManuallyStoppedRef.current).toBe(outcome !== "success");
    },
  );

  it("does not clear a reply draft after the chat unmounts", async () => {
    mockInput = "Use option A";
    let resolveReply!: (response: Response) => void;
    jest
      .mocked(global.fetch)
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (resolveReply = resolve)),
      );
    const { result, unmount } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        pendingUserWait: {
          runId: "run-1",
          toolCallId: "tool-1",
          status: "waiting",
        },
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.handleSubmit({
        preventDefault: jest.fn(),
      } as any);
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveReply({ ok: true, status: 200 } as Response);
      expect(await submission).toBe(true);
    });
    expect(mockClearInput).not.toHaveBeenCalled();
  });

  it.each([
    "/goal pause",
    "/goal stop",
    "/goal clear",
    "A new bounded follow-up",
  ])("retains the active response before admitting %s", async (input) => {
    mockInput = input;
    mockMessageQueue = [];
    const calls: string[] = [];
    let finishSave!: (value: null) => void;
    mockSaveAssistantMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    jest.mocked(global.fetch).mockImplementation(async (url, options) => {
      const path = String(url);
      if (path.startsWith("/api/agent-goal?"))
        return {
          ok: true,
          json: async () => ({ goal: { generation: 4, activeRunId: "run-1" } }),
        } as Response;
      if (path === "/api/agent/cancel")
        return {
          ok: true,
          json: async () => ({ outcome: "canceled", runId: "run-1" }),
        } as Response;
      if (path === "/api/agent-goal") {
        calls.push("goal-control");
        expect(JSON.parse(String(options?.body))).toMatchObject({
          generation: 4,
        });
        return {
          ok: true,
          json: async () => ({
            state: input === "/goal clear" ? "canceled" : "paused",
          }),
        } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        goalState: "running",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.handleSubmit({
        preventDefault: jest.fn(),
      } as any);
    });
    await waitFor(() => expect(mockSaveAssistantMessage).toHaveBeenCalled());
    expect(calls).toEqual([]);
    expect(mockSendMessage).not.toHaveBeenCalled();
    await act(async () => {
      finishSave(null);
      expect(await submission).toBe(true);
    });
    expect(calls).toEqual(["goal-control"]);
    if (input.startsWith("/goal"))
      expect(mockSendMessage).not.toHaveBeenCalled();
    else
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: input }),
        expect.anything(),
      );
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it.each(["/goal clear", "Follow-up after failed save"])(
    "keeps %s when the active response cannot be saved",
    async (input) => {
      mockInput = input;
      mockMessageQueue = [];
      mockSaveAssistantMessage.mockRejectedValueOnce(
        new Error("Synthetic partial save failure"),
      );
      jest.mocked(global.fetch).mockImplementation(
        async (url) =>
          ({
            ok: true,
            json: async () =>
              String(url).startsWith("/api/agent-goal?")
                ? { goal: { generation: 4, activeRunId: "run-1" } }
                : { outcome: "canceled" },
          }) as Response,
      );
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          goalState: "running",
          goalGeneration: 4,
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: "run-1" },
        }),
      );
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.anything(),
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockQueueMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
    },
  );

  it.each([
    { generation: 5, activeRunId: "run-1" },
    { generation: 4, activeRunId: "replacement-run" },
  ])("rejects a goal control after replacement: %p", async (goal) => {
    mockInput = "/goal clear";
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ goal }),
    } as Response);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        goalState: "running",
        goalGeneration: 4,
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(false);
    });
    expect(mockStop).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/agent-goal",
      expect.anything(),
    );
    expect(mockClearInput).not.toHaveBeenCalled();
  });

  it("targets the persisted continuation when the local stream still identifies its predecessor", async () => {
    mockInput = "/goal pause";
    jest.mocked(global.fetch).mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () =>
            String(url).startsWith("/api/agent-goal?")
              ? { goal: { generation: 4, activeRunId: "successor-run" } }
              : { state: "paused", outcome: "canceled" },
        }) as Response,
    );
    const activeRunRef = { current: "predecessor-run" };
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        goalState: "running",
        goalGeneration: 4,
        persistedTriggerRunId: "successor-run",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: activeRunRef,
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(true);
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "successor-run",
        }),
      }),
    );
    expect(mockSaveAssistantMessage).toHaveBeenCalled();
  });

  it("does not stop or normalize a different run whose start is still pending", async () => {
    let finishStart!: (response: Response) => void;
    const controller = new AbortController();
    jest.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stream = fetchAgentLongStream({
      method: "POST",
      body: JSON.stringify({ chatId: "chat-1" }),
      signal: controller.signal,
    }).catch((error: Error) => error);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "goal-run" },
      }),
    );
    let stopped!: Promise<boolean>;
    act(() => {
      stopped = result.current.handleStop({
        requireSavedResponse: true,
        expectedTriggerRunId: "goal-run",
      });
    });
    expect(mockStop).not.toHaveBeenCalled();
    await act(async () => {
      finishStart({
        ok: true,
        json: async () => ({
          runId: "new-unrelated-run",
          publicAccessToken: "synthetic",
        }),
      } as Response);
      controller.abort();
      expect(await stopped).toBe(false);
    });
    expect(await stream).toMatchObject({ name: "AbortError" });
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockSaveAssistantMessage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe("explicit Stop marker", () => {
    const renderStop = ({
      mode,
      runId,
      currentMessages = messages,
    }: {
      mode: "ask" | "agent";
      runId?: string;
      currentMessages?: ChatMessage[];
    }) => {
      mockChatMode = mode;
      return renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages: currentMessages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: runId },
        }),
      ).result;
    };
    const stop = async (
      result: { current: ReturnType<typeof useChatHandlers> },
      options?: Parameters<ReturnType<typeof useChatHandlers>["handleStop"]>[0],
    ) => {
      let stopped: boolean | undefined;
      await act(async () => {
        stopped = await result.current.handleStop(options);
      });
      return stopped;
    };
    const localMarkerUpdate = () =>
      mockSetMessages.mock.calls
        .map(([update]) => update)
        .find(
          (update): update is (prev: ChatMessage[]) => ChatMessage[] =>
            typeof update === "function",
        );

    it("marks the partial Ask reply only after Convex confirms it stopped a running stream", async () => {
      let finishCancel!: (wasRunning: boolean) => void;
      mockCancelStream.mockImplementationOnce(
        () => new Promise((resolve) => (finishCancel = resolve)),
      );
      mockMarkUserStopped.mockResolvedValueOnce(true);
      const result = renderStop({ mode: "ask" });
      let stopping!: Promise<boolean>;
      act(() => {
        stopping = result.current.handleStop();
      });
      await waitFor(() => expect(mockCancelStream).toHaveBeenCalled());
      expect(mockMarkUserStopped).not.toHaveBeenCalled();
      await act(async () => {
        finishCancel(true);
        expect(await stopping).toBe(true);
      });
      expect(mockMarkUserStopped).toHaveBeenCalledWith({
        chatId: "chat-1",
        messageId: "assistant-1",
        role: "assistant",
      });
      expect(localMarkerUpdate()?.(messages)).toEqual([
        messages[0],
        { ...messages[1], metadata: { userStopped: true } },
      ]);
    });

    it("anchors a Stop before any reply to the user's request", async () => {
      mockCancelStream.mockResolvedValueOnce(true);
      mockMarkUserStopped.mockResolvedValueOnce(true);
      const result = renderStop({
        mode: "ask",
        currentMessages: [messages[0]],
      });
      expect(await stop(result)).toBe(true);
      expect(mockMarkUserStopped).toHaveBeenCalledWith({
        chatId: "chat-1",
        messageId: "user-1",
        role: "user",
      });
    });

    it.each([
      { label: "already finished", cancel: () => Promise.resolve(false) },
      {
        label: "failed",
        cancel: () => Promise.reject(new Error("Synthetic cancel failure")),
      },
    ])("leaves no marker when Ask cancellation $label", async ({ cancel }) => {
      const log = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        mockCancelStream.mockImplementationOnce(cancel);
        const result = renderStop({ mode: "ask" });
        await stop(result);
        expect(mockMarkUserStopped).not.toHaveBeenCalled();
        expect(localMarkerUpdate()).toBeUndefined();
      } finally {
        log.mockRestore();
      }
    });

    it("marks the reply after the exact Agent run is canceled", async () => {
      mockMarkUserStopped.mockResolvedValueOnce(true);
      const result = renderStop({ mode: "agent", runId: "run-1" });
      expect(await stop(result)).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent/cancel",
        expect.objectContaining({
          body: JSON.stringify({
            chatId: "chat-1",
            expectedTriggerRunId: "run-1",
          }),
        }),
      );
      expect(mockMarkUserStopped).toHaveBeenCalledWith({
        chatId: "chat-1",
        messageId: "assistant-1",
        role: "assistant",
      });
    });

    it.each([
      {
        label: "stale",
        response: {
          ok: false,
          status: 409,
          json: async () => ({ reason: "stale_run", activeTriggerRunId: null }),
        },
      },
      {
        label: "rejected",
        response: { ok: false, status: 400, json: async () => ({}) },
      },
    ])(
      "leaves no marker when the Agent cancellation is $label",
      async ({ response }) => {
        const log = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
          jest.mocked(global.fetch).mockResolvedValue(response as Response);
          const result = renderStop({ mode: "agent", runId: "run-1" });
          expect(await stop(result)).toBe(false);
          expect(mockMarkUserStopped).not.toHaveBeenCalled();
        } finally {
          log.mockRestore();
        }
      },
    );

    it("leaves goal controls unmarked even when their run is canceled", async () => {
      const result = renderStop({ mode: "agent", runId: "run-1" });
      expect(
        await stop(result, {
          requireSavedResponse: true,
          expectedTriggerRunId: "run-1",
        }),
      ).toBe(true);
      expect(mockMarkUserStopped).not.toHaveBeenCalled();
    });

    it.each([
      { label: "refused", mark: () => Promise.resolve(false) },
      {
        label: "failed",
        mark: () => Promise.reject(new Error("Synthetic marker failure")),
      },
    ])(
      "keeps a successful Stop when the marker is $label",
      async ({ mark }) => {
        const log = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
          mockCancelStream.mockResolvedValueOnce(true);
          mockMarkUserStopped.mockImplementationOnce(mark);
          const result = renderStop({ mode: "ask" });
          expect(await stop(result)).toBe(true);
          expect(mockMarkUserStopped).toHaveBeenCalledTimes(1);
          expect(localMarkerUpdate()).toBeUndefined();
        } finally {
          log.mockRestore();
        }
      },
    );
  });

  const renderSummarySteer = (isSummarizing = true, runId = "run-1") => {
    const isSendingNowRef = { current: false };
    const hasManuallyStoppedRef = { current: false };
    const hook = renderHook(
      ({ isSummarizing, chatId, currentMessages }) =>
        useChatHandlers({
          chatId,
          messages: currentMessages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSummarizing,
          isSendingNowRef,
          hasManuallyStoppedRef,
          activeTriggerRunRef: { current: runId },
        }),
      {
        initialProps: {
          isSummarizing,
          chatId: "chat-1",
          currentMessages: messages,
        },
      },
    );
    return { ...hook, isSendingNowRef, hasManuallyStoppedRef };
  };

  it("finishes summarizing before Send now cancels and sends exactly once", async () => {
    const { result, rerender, isSendingNowRef } = renderSummarySteer();
    await act(async () => result.current.handleSendNow("queued-1"));
    expect(result.current.hasPendingSummarySteer).toBe(true);
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockCancelStream).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();

    // A summary heartbeat must not release the pending steer.
    rerender({
      isSummarizing: true,
      chatId: "chat-1",
      currentMessages: messages,
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    const completedMessages: ChatMessage[] = [
      ...messages.slice(0, -1),
      { ...messages[1], parts: [{ type: "text", text: "Latest progress" }] },
    ];
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: completedMessages,
      });
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parts: completedMessages[1].parts }),
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Change direction" }),
      expect.any(Object),
    );
    rerender({
      isSummarizing: false,
      chatId: "chat-1",
      currentMessages: completedMessages,
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a deferred Send now until the server's queued message has a run", async () => {
    const { result, rerender } = renderSummarySteer();
    await act(async () => result.current.handleSendNow("queued-1"));
    expect(result.current.hasPendingSummarySteer).toBe(true);
    // The server claims an earlier row before the summary settles.
    mockMessageQueue = [
      {
        id: "queued-0",
        text: "Sent by the server",
        files: [],
        timestamp: 1,
        dispatching: true,
      },
      ...mockMessageQueue,
    ];
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: messages,
      });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.current.hasPendingSummarySteer).toBe(true);
    // Its run is attached and the row is gone: the deferred send proceeds.
    mockMessageQueue = mockMessageQueue.slice(1);
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: messages,
      });
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.hasPendingSummarySteer).toBe(false);
  });

  it.each(["submission", "Send now"])(
    "retains a summary steer chosen by %s until an earlier handoff releases",
    async (source) => {
      jest.useFakeTimers();
      try {
        const { result, rerender } = renderSummarySteer();
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
        await act(async () => result.current.handleSendNow("queued-1"));
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        const second = { id: "queued-2", text: "Second", timestamp: 124 };
        mockMessageQueue = [...mockMessageQueue, second];
        mockQueueMessage.mockReturnValueOnce("queued-2");
        mockInput = "Second";
        rerender({
          isSummarizing: true,
          chatId: "chat-1",
          currentMessages: messages,
        });
        await act(async () => {
          if (source === "Send now")
            await result.current.handleSendNow("queued-2");
          else
            await result.current.handleSubmit({
              preventDefault: jest.fn(),
            } as any);
        });
        await act(async () => {
          rerender({
            isSummarizing: false,
            chatId: "chat-1",
            currentMessages: messages,
          });
        });
        expect(result.current.hasPendingSummarySteer).toBe(true);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        await act(async () => jest.advanceTimersByTime(200));
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
        expect(mockSendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "Second" }),
          expect.any(Object),
        );
        expect(result.current.hasPendingSummarySteer).toBe(false);
        await act(async () => jest.advanceTimersByTime(200));
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(["queue", "stop-and-send"] as const)(
    "queues a new %s submission during summarization and steers immediately afterward",
    async (behavior) => {
      mockQueueBehavior = behavior;
      mockInput = "Change direction";
      mockMessageQueue = [
        { id: "older", text: "Older queued message", timestamp: 100 },
      ];
      mockQueueMessage.mockImplementationOnce(() => {
        mockMessageQueue = [
          ...mockMessageQueue,
          { id: "queued-1", text: mockInput, files: [], timestamp: 123 },
        ];
        return "queued-1";
      });
      const { result, rerender } = renderSummarySteer();
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(true);
      });
      expect(mockQueueMessage).toHaveBeenCalledWith("Change direction", []);
      expect(mockClearInput).toHaveBeenCalledTimes(1);
      expect(mockClearUploadedFiles).toHaveBeenCalledTimes(1);
      expect(mockStop).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      await act(async () => {
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Change direction" }),
        expect.any(Object),
      );
    },
  );

  describe("mid-run steering", () => {
    beforeEach(() => {
      mockAgentSteeringEnabled = true;
      mockQueueBehavior = "steer";
      mockInput = "Use the staging host";
      mockMessageQueue = [];
    });

    const submit = async (
      result: { current: ReturnType<typeof useChatHandlers> },
      event: Record<string, unknown> = {},
    ) => {
      let accepted: boolean | undefined;
      await act(async () => {
        accepted = await result.current.handleSubmit({
          preventDefault: jest.fn(),
          ...event,
        } as any);
      });
      return accepted;
    };

    it("sends Enter into the running Agent without stopping or queueing", async () => {
      const { result } = renderSummarySteer(false);
      expect(await submit(result)).toBe(true);
      expect(mockCreateAgentSteer).toHaveBeenCalledWith({
        chatId: "chat-1",
        id: expect.any(String),
        text: "Use the staging host",
        sentAt: expect.any(Number),
        settings: {
          agentPermissionMode: "full_access",
          sandboxPreference: "e2b",
          selectedModel: "hackerai-standard",
        },
      });
      expect(mockQueueMessage).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).toHaveBeenCalledTimes(1);
    });

    it("records the approval mode a steer was sent under", async () => {
      // If the run ends unread, the steer is queued and must not later start
      // with more permission than the user chose.
      mockAgentPermissionMode = "ask_approval";
      const { result } = renderSummarySteer(false);
      expect(await submit(result)).toBe(true);
      expect(mockCreateAgentSteer).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            agentPermissionMode: "ask_approval",
          }),
        }),
      );
    });

    it("queues with Cmd/Ctrl+Enter instead of steering", async () => {
      const { result } = renderSummarySteer(false);
      expect(await submit(result, { metaKey: true })).toBe(true);
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", []);
    });

    it("queues the message when the run ended before it could steer", async () => {
      mockCreateAgentSteer.mockResolvedValueOnce("no_active_run");
      const { result } = renderSummarySteer(false);
      expect(await submit(result)).toBe(true);
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", []);
      expect(mockStop).not.toHaveBeenCalled();
    });

    it("moves a queued message into the running Agent from its Steer button", async () => {
      mockMessageQueue = [
        { id: "queued-1", text: "Change direction", files: [], timestamp: 1 },
      ];
      const { result, isSendingNowRef } = renderSummarySteer(false);
      await act(async () => result.current.handleSendNow("queued-1"));
      // A steer that is never read returns to its original queue position.
      expect(mockCreateAgentSteer).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Change direction", sentAt: 1 }),
      );
      expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
      expect(mockStop).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(isSendingNowRef.current).toBe(false);
    });

    it("queues a follow-up with attachments instead of stopping the run", async () => {
      mockUploadedFiles = [
        {
          file: new File(["scan"], "scan.txt"),
          uploaded: true,
          fileId: "scan-file",
        },
      ];
      const { result } = renderSummarySteer(false);
      expect(await submit(result)).toBe(true);
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", [
        expect.objectContaining({ fileId: "scan-file" }),
      ]);
      expect(mockStop).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("only queues attachments sent during summarization", async () => {
      mockUploadedFiles = [
        {
          file: new File(["scan"], "scan.txt"),
          uploaded: true,
          fileId: "scan-file",
        },
      ];
      const { result, rerender } = renderSummarySteer(true);
      expect(await submit(result)).toBe(true);
      expect(mockQueueMessage).toHaveBeenCalledTimes(1);
      expect(result.current.hasPendingSummarySteer).toBe(false);
      await act(async () => {
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
      });
      expect(mockStop).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("only queues a Cmd/Ctrl+Enter follow-up sent during summarization", async () => {
      const { result, rerender } = renderSummarySteer(true);
      expect(await submit(result, { metaKey: true })).toBe(true);
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", []);
      expect(result.current.hasPendingSummarySteer).toBe(false);
      await act(async () => {
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
      });
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
    });

    it("still stops the run for a Stop & send deferred by summarization", async () => {
      mockQueueBehavior = "stop-and-send";
      mockQueueMessage.mockImplementationOnce(() => {
        mockMessageQueue = [
          { id: "queued-1", text: mockInput, files: [], timestamp: 123 },
        ];
        return "queued-1";
      });
      const { result, rerender } = renderSummarySteer(true);
      expect(await submit(result)).toBe(true);
      expect(result.current.hasPendingSummarySteer).toBe(true);
      await act(async () => {
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
      });
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });

    it("keeps a queued message edited while its steer was pending", async () => {
      mockMessageQueue = [
        { id: "queued-1", text: "Change direction", files: [], timestamp: 1 },
      ];
      let accept!: (outcome: string) => void;
      mockCreateAgentSteer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      const { result, rerender } = renderSummarySteer(false);
      let sending!: Promise<void>;
      act(() => {
        sending = result.current.handleSendNow("queued-1");
      });
      mockMessageQueue = [
        { id: "queued-1", text: "Edited meanwhile", files: [], timestamp: 1 },
      ];
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: messages,
      });
      await act(async () => {
        accept("pending");
        await sending;
      });
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
    });

    it("marks the run Stop cancels so its unread steers come back held", async () => {
      const { wasRunStopped } = jest.requireActual<
        typeof import("@/app/hooks/useUnreadSteerRequeue")
      >("@/app/hooks/useUnreadSteerRequeue");
      const { result } = renderSummarySteer(false, "run-stop-check");
      expect(wasRunStopped("run-stop-check")).toBe(false);
      await act(async () => {
        await result.current.handleStop();
      });
      expect(wasRunStopped("run-stop-check")).toBe(true);
    });

    it("keeps a queued message queued when the run refuses the steer", async () => {
      mockCreateAgentSteer.mockResolvedValueOnce("no_active_run");
      mockMessageQueue = [
        { id: "queued-1", text: "Change direction", files: [], timestamp: 1 },
      ];
      const { result } = renderSummarySteer(false);
      const releaseVersion = result.current.sendNowReleaseVersion;
      await act(async () => result.current.handleSendNow("queued-1"));
      // Automatic delivery rechecks once the hold is released.
      expect(result.current.sendNowReleaseVersion).toBeGreaterThan(
        releaseVersion,
      );
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("never starts a queued message while the server is sending an earlier one", async () => {
      mockMessageQueue = [
        {
          id: "queued-1",
          text: "Sent by the server",
          files: [],
          timestamp: 1,
          dispatching: true,
        },
        { id: "queued-2", text: "Next", files: [], timestamp: 2 },
      ];
      const { result } = renderSummarySteer(false);
      for (const id of ["queued-1", "queued-2"])
        await act(async () => result.current.handleSendNow(id));
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
    });

    it("queues a new message behind one the server is sending", async () => {
      mockMessageQueue = [
        {
          id: "queued-1",
          text: "Sent by the server",
          files: [],
          timestamp: 1,
          dispatching: true,
        },
      ];
      // No run is active yet: the server has not attached its run.
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "ready",
          isSummarizing: false,
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: null },
        }),
      );
      expect(await submit(result)).toBe(true);
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", []);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
    });

    it("leaves Ask mode's Send Now on its existing path", async () => {
      const toastError = jest.spyOn(toast, "error");
      mockChatMode = "ask";
      mockMessageQueue = [
        { id: "queued-1", text: "Change direction", files: [], timestamp: 1 },
      ];
      const { result } = renderSummarySteer(false);
      await act(async () => result.current.handleSendNow("queued-1"));
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalledWith(
        "Could not steer the Agent run",
        expect.anything(),
      );
      toastError.mockRestore();
    });

    it("never steers when the rollout is off, even with Cmd/Ctrl+Enter", async () => {
      mockAgentSteeringEnabled = false;
      mockQueueBehavior = "queue";
      const { result } = renderSummarySteer(false);
      expect(await submit(result, { metaKey: true })).toBe(true);
      expect(mockCreateAgentSteer).not.toHaveBeenCalled();
      expect(mockQueueMessage).toHaveBeenCalledWith("Use the staging host", []);
    });
  });

  it("keeps the draft when queue admission fails after rendering available capacity", async () => {
    mockInput = "Keep my draft";
    mockMessageQueue = [];
    mockQueueMessage.mockReturnValueOnce(undefined);
    const { result, isSendingNowRef } = renderSummarySteer();
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(false);
    });
    expect(mockQueueMessage).toHaveBeenCalledWith("Keep my draft", []);
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    expect(isSendingNowRef.current).toBe(false);
    expect(result.current.hasPendingSummarySteer).toBe(false);
  });

  it.each([false, true])(
    "preserves deferred submission order unless Send now explicitly selects another message (override: %s)",
    async (override) => {
      mockMessageQueue = [];
      mockQueueMessage
        .mockImplementationOnce(() => {
          mockMessageQueue = [
            { id: "queued-1", text: "First", timestamp: 123 },
          ];
          return "queued-1";
        })
        .mockImplementationOnce(() => {
          mockMessageQueue = [
            ...mockMessageQueue,
            { id: "queued-2", text: "Second", timestamp: 124 },
          ];
          return "queued-2";
        });
      const { result, rerender } = renderSummarySteer();
      mockInput = "First";
      await act(async () => {
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any);
      });
      mockInput = "Second";
      await act(async () => {
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any);
      });
      rerender({
        isSummarizing: true,
        chatId: "chat-1",
        currentMessages: messages,
      });
      if (override) {
        await act(async () => result.current.handleSendNow("queued-2"));
      }
      expect(mockStop).not.toHaveBeenCalled();
      await act(async () => {
        rerender({
          isSummarizing: false,
          chatId: "chat-1",
          currentMessages: messages,
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: override ? "Second" : "First" }),
        expect.any(Object),
      );
      expect(mockRemoveQueuedMessage).toHaveBeenCalledWith(
        override ? "queued-2" : "queued-1",
      );
    },
  );

  it("rejects an oversized deferred submission before clearing the draft or interrupting compaction", async () => {
    mockInput = "Too large";
    const validation = require("@/lib/utils/client-token-validation");
    const check = jest
      .spyOn(validation, "getInputTokenLimitStatus")
      .mockResolvedValueOnce({ exceedsLimit: true, tokenCount: 1_000_000 });
    try {
      const { result } = renderSummarySteer();
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(mockQueueMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(mockClearUploadedFiles).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });

  it("invalidates a submission stopped while token validation is pending", async () => {
    mockInput = "Stopped submission";
    let finishValidation!: (status: { exceedsLimit: false }) => void;
    const check = jest
      .spyOn(
        require("@/lib/utils/client-token-validation"),
        "getInputTokenLimitStatus",
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishValidation = resolve;
          }),
      );
    try {
      const { result, hasManuallyStoppedRef } = renderSummarySteer();
      let submitting!: Promise<boolean>;
      act(() => {
        submitting = result.current.handleSubmit({
          preventDefault: jest.fn(),
        } as any);
      });
      await act(async () => {
        await result.current.handleStop();
      });
      // A later action can clear the manual-stop boolean; it cannot revive
      // an older submission that was stopped during validation.
      hasManuallyStoppedRef.current = false;
      await act(async () => {
        finishValidation({ exceedsLimit: false });
        expect(await submitting).toBe(false);
      });
      expect(mockQueueMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(result.current.hasPendingSummarySteer).toBe(false);
    } finally {
      check.mockRestore();
    }
  });

  it.each([true, false])(
    "steers when summarization changes during validation (initially summarizing: %s)",
    async (initiallySummarizing) => {
      mockInput = "Submission during preparation";
      let finishValidation!: (status: { exceedsLimit: false }) => void;
      const check = jest
        .spyOn(
          require("@/lib/utils/client-token-validation"),
          "getInputTokenLimitStatus",
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishValidation = resolve;
            }),
        );
      mockQueueMessage.mockImplementationOnce(() => {
        mockMessageQueue = [
          { id: "queued-1", text: mockInput, timestamp: 123 },
        ];
        return "queued-1";
      });
      try {
        const { result, rerender } = renderSummarySteer(initiallySummarizing);
        let submitting!: Promise<boolean>;
        act(() => {
          submitting = result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any);
        });
        rerender({
          isSummarizing: !initiallySummarizing,
          chatId: "chat-1",
          currentMessages: messages,
        });
        await act(async () => {
          finishValidation({ exceedsLimit: false });
          expect(await submitting).toBe(true);
        });
        if (!initiallySummarizing) {
          expect(mockSendMessage).not.toHaveBeenCalled();
          await act(async () => {
            rerender({
              isSummarizing: false,
              chatId: "chat-1",
              currentMessages: messages,
            });
          });
        }
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Submission during preparation" }),
          expect.any(Object),
        );
      } finally {
        check.mockRestore();
      }
    },
  );

  it("honors Stop while a deferred Send now handoff is settling", async () => {
    let finishSave!: (value: null) => void;
    mockCancelStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { result, rerender } = renderSummarySteer();
    rerender({
      isSummarizing: false,
      chatId: "chat-1",
      currentMessages: messages,
    });
    let steering!: Promise<void>;
    act(() => {
      steering = result.current.handleSendNow("queued-1");
    });
    await act(async () => {
      await result.current.handleStop();
    });
    await act(async () => {
      finishSave(null);
      await steering;
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
  });

  it.each(["text", "attachments"])(
    "preserves newer %s while admitting the captured submission after validation",
    async (change) => {
      mockInput = "Original submission";
      let finishValidation!: (status: { exceedsLimit: false }) => void;
      const check = jest
        .spyOn(
          require("@/lib/utils/client-token-validation"),
          "getInputTokenLimitStatus",
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishValidation = resolve;
            }),
        );
      try {
        const { result, rerender } = renderSummarySteer();
        let submitting!: Promise<boolean>;
        act(() => {
          submitting = result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any);
        });
        if (change === "text") mockInput = "New draft";
        else
          mockUploadedFiles = [
            {
              file: new File(["new"], "new.txt"),
              uploaded: true,
              fileId: "new-file",
            },
          ];
        rerender({
          isSummarizing: true,
          chatId: "chat-1",
          currentMessages: messages,
        });
        await act(async () => {
          finishValidation({ exceedsLimit: false });
          expect(await submitting).toBe(true);
        });
        expect(mockQueueMessage).toHaveBeenCalledWith(
          "Original submission",
          [],
        );
        expect(mockClearInput).not.toHaveBeenCalled();
        expect(mockClearUploadedFiles).not.toHaveBeenCalled();
      } finally {
        check.mockRestore();
      }
    },
  );

  it("preserves an oversized Ask attachment submitted during summarization", async () => {
    mockChatMode = "ask";
    mockUploadedFiles = [
      {
        file: new File(["fixture"], "fixture.txt"),
        fileId: "file-1",
        uploaded: true,
        tokens: 1_000_000,
      },
    ];
    const { result } = renderSummarySteer();
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(false);
    });
    expect(mockQueueMessage).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("lets explicit Stop cancel summarization and discard the deferred steer", async () => {
    const { result, rerender } = renderSummarySteer();
    await act(async () => result.current.handleSendNow("queued-1"));
    await act(async () => {
      await result.current.handleStop();
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: messages,
      });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
  });

  it("does not send a removed deferred message", async () => {
    const { result, rerender, isSendingNowRef } = renderSummarySteer();
    await act(async () => result.current.handleSendNow("queued-1"));
    mockMessageQueue = [];
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-1",
        currentMessages: messages,
      });
    });
    expect(isSendingNowRef.current).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("does not carry a deferred steer into another chat", async () => {
    const { result, rerender, isSendingNowRef } = renderSummarySteer();
    await act(async () => result.current.handleSendNow("queued-1"));
    await act(async () => {
      rerender({
        isSummarizing: false,
        chatId: "chat-2",
        currentMessages: messages,
      });
    });
    expect(isSendingNowRef.current).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it.each(["agent", "ask"])(
    "keeps a rejected new %s task on the draft route",
    async (mode) => {
      window.history.replaceState({}, "", "/");
      mockInput = "Run a bounded request";
      mockChatMode = mode;
      let rejectAdmission!: (error: Error) => void;
      const admission = new Promise<void>((_resolve, reject) => {
        rejectAdmission = reject;
      });
      mockSendMessage.mockImplementationOnce(() => admission);
      const log = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { result } = renderHook(() =>
          useChatHandlers({
            chatId: "rejected-new-task",
            messages: [],
            sendMessage: mockSendMessage,
            stop: mockStop,
            regenerate: jest.fn(),
            setMessages: mockSetMessages,
            isExistingChat: false,
            status: "ready",
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
          }),
        );
        await act(async () => {
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any);
        });
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: mockInput }),
          expect.anything(),
        );
        expect(window.location.pathname).toBe("/");
        await act(async () => {
          rejectAdmission(new Error("Workspace recovery blocks admission"));
          await admission.catch(() => {});
        });
        // Reload must resolve the draft page, not an unsaved /c/<id> route.
        expect(window.location.pathname).toBe("/");
      } finally {
        log.mockRestore();
      }
    },
  );

  it("keeps a new local-upload turn mounted on the draft route until admission", async () => {
    window.history.replaceState({}, "", "/");
    mockInput = "Read these files";
    mockSandboxPreference = "desktop";
    mockUploadedFiles = ["txt", "pdf", "docx"].map((extension) => ({
      file: new File(["fixture"], `fixture.${extension}`),
      uploaded: true,
      storage: "local-desktop",
      localAttachmentId: extension,
      localPath: `/fixtures/file.${extension}`,
    }));
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "not-yet-persisted",
        messages: [],
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: false,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(true);
    });
    expect(window.location.pathname).toBe("/");
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: mockInput,
        files: mockUploadedFiles.map((file) =>
          expect.objectContaining({ localPath: file.localPath }),
        ),
      }),
      expect.anything(),
    );
  });

  it("retries the latest queued message without native findLast or replacing an uncertain run", async () => {
    mockQueuedDeliveryStatus = "failed";
    const sendQueuedMessage = jest.fn(async () => {});
    const history = [
      { id: "older-user", role: "user", parts: [] },
      { id: "older-assistant", role: "assistant", parts: [] },
      { id: "queued-1", role: "user", parts: [] },
    ] as ChatMessage[];
    Object.defineProperty(history, "findLast", { value: undefined });
    Object.freeze(history);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: history,
        sendMessage: mockSendMessage,
        sendQueuedMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "error",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "uncertain-run" },
      }),
    );
    await act(() => result.current.handleRetry({ selectedModel: "auto" }));
    expect(sendQueuedMessage).toHaveBeenCalledWith(
      "queued-1",
      expect.objectContaining({ selectedModel: "auto" }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "failed"] as const)(
    "routes Ask Send Now by the selected item's delivery state: %s",
    async (deliveryStatus) => {
      mockChatMode = "ask";
      mockQueuedDeliveryStatus = deliveryStatus;
      const sendQueuedMessage = jest.fn(async () => {});
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          sendQueuedMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "ready",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      await act(() => result.current.handleSendNow("queued-1"));
      if (deliveryStatus) {
        expect(sendQueuedMessage).toHaveBeenCalledWith(
          "queued-1",
          expect.any(Object),
        );
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
      } else {
        expect(sendQueuedMessage).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Change direction" }),
          expect.objectContaining({
            body: expect.objectContaining({ mode: "ask" }),
          }),
        );
        expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
      }
    },
  );

  it.each(["tool-run_terminal_cmd", "tool-file_write"])(
    "persists a stopped %s approval instead of resurrecting it on reload",
    async (type) => {
      const stoppedTool = {
        type,
        toolCallId: "pending-tool",
        state: "approval-requested",
        approval: { id: "approval-1" },
        input:
          type === "tool-file_write"
            ? { path: "/tmp/qa.txt", text: "qa" }
            : { command: "sleep 45" },
      };
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages: [
            { id: "run-pending", role: "assistant", parts: [stoppedTool] },
          ] as ChatMessage[],
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: "run-pending" },
        }),
      );
      await act(async () => {
        await result.current.handleStop();
      });
      expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "run-pending",
          parts: [
            expect.objectContaining({
              toolCallId: "pending-tool",
              input: stoppedTool.input,
              state: "output-error",
              errorText: "Stopped by user before the tool completed.",
            }),
          ],
        }),
      );
    },
  );

  it("starts native cancellation without waiting for an offline server", async () => {
    let finishCancel!: (response: Response) => void;
    (globalThis.fetch as jest.Mock<typeof fetch>).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-offline" },
      }),
    );
    let stopped!: Promise<boolean>;
    act(() => {
      stopped = result.current.handleStop();
    });
    expect(mockCancelDesktopRunLocally).toHaveBeenCalledWith(
      "chat-1",
      "run-offline",
    );
    await act(async () => {
      await waitFor(() => expect(finishCancel).toBeDefined());
      finishCancel({
        ok: true,
        json: async () => ({ canceled: true }),
      } as Response);
      await stopped;
    });
  });

  it("delivers Stop after leaving the chat without targeting a replacement run", async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.mocked(fetch);
      fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      const activeTriggerRunRef = { current: "run-offline-navigation" };
      const { result, unmount } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-navigation",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef,
        }),
      );
      let stopped!: Promise<boolean>;
      act(() => {
        stopped = result.current.handleStop();
      });
      expect(mockCancelDesktopRunLocally).toHaveBeenCalledWith(
        "chat-navigation",
        "run-offline-navigation",
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      activeTriggerRunRef.current = "run-replacement";
      unmount();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
        expect(await stopped).toBe(true);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls) {
        expect(JSON.parse(init!.body as string)).toEqual({
          chatId: "chat-navigation",
          expectedTriggerRunId: "run-offline-navigation",
        });
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for a pending start and cancels its exact run after an early Stop", async () => {
    let finishStart!: (response: Response) => void;
    const controller = new AbortController();
    const activeTriggerRunRef = { current: "run-previous" };
    const fetchMock = globalThis.fetch as jest.Mock<typeof fetch>;
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          finishStart = resolve;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const onRunStarted = jest.fn();
    const stream = fetchAgentLongStream(
      {
        method: "POST",
        body: JSON.stringify({ chatId: "chat-1" }),
        signal: controller.signal,
      },
      onRunStarted,
    ).catch((error: Error) => error);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: () => controller.abort(),
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "submitted",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef,
      }),
    );
    let stopped!: Promise<boolean>;
    act(() => {
      stopped = result.current.handleStop();
    });
    // The old no-active-run response must not be mistaken for stopping a start
    // that has not returned its handle yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCancelDesktopRunLocally).not.toHaveBeenCalled();
    expect(mockCaptureCancellationEvent).not.toHaveBeenCalled();
    activeTriggerRunRef.current = "run-replacement";
    await act(async () => {
      finishStart({
        ok: true,
        json: async () => ({
          runId: "run-starting",
          chatId: "chat-1",
          publicAccessToken: "synthetic",
        }),
      } as Response);
      expect(await stopped).toBe(true);
    });
    expect(mockCaptureCancellationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_run_cancellation_requested",
        properties: expect.objectContaining({
          action: "stop",
          triggerRunId: "run-starting",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "run-starting",
        }),
      }),
    );
    expect(mockCancelDesktopRunLocally).toHaveBeenCalledWith(
      "chat-1",
      "run-starting",
    );
    expect(await stream).toMatchObject({ name: "AbortError" });
    expect(onRunStarted).not.toHaveBeenCalled();
  });

  it.each(["run-previous", null])(
    "handles failed starts without broad cancellation (captured run: %s)",
    async (capturedRun) => {
      let failStart!: (error: Error) => void;
      jest.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise<Response>((_, reject) => {
            failStart = reject;
          }),
      );
      const controller = new AbortController();
      const stream = fetchAgentLongStream({
        method: "POST",
        body: JSON.stringify({ chatId: "chat-1" }),
        signal: controller.signal,
      }).catch((error: Error) => error);
      const activeTriggerRunRef = { current: capturedRun };
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: () => controller.abort(),
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "submitted",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef,
        }),
      );
      let stopped!: Promise<boolean>;
      act(() => {
        stopped = result.current.handleStop();
      });
      activeTriggerRunRef.current = "run-replacement";
      await act(async () => {
        failStart(new Error("Synthetic lost start response"));
        expect(await stopped).toBe(false);
      });
      if (capturedRun) {
        expect(fetch).toHaveBeenLastCalledWith(
          "/api/agent/cancel",
          expect.objectContaining({
            body: JSON.stringify({
              chatId: "chat-1",
              expectedTriggerRunId: capturedRun,
            }),
          }),
        );
      } else {
        expect(fetch).toHaveBeenCalledTimes(1);
      }
      expect(await stream).toMatchObject({
        message: "Synthetic lost start response",
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
    },
  );

  it("does not broadly cancel a chat when Stop has no captured run or pending start", async () => {
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "submitted",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: undefined },
      }),
    );
    await act(async () => {
      await result.current.handleStop();
    });
    expect(mockStop).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockCaptureCancellationEvent).not.toHaveBeenCalled();
  });

  it("retains the starting run while Send now waits for todo persistence", async () => {
    let finishStart!: (response: Response) => void;
    let finishSave!: (value: null) => void;
    mockCancelStream.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishSave = resolve;
        }),
    );
    const controller = new AbortController();
    jest.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stream = fetchAgentLongStream({
      method: "POST",
      body: JSON.stringify({ chatId: "chat-1" }),
      signal: controller.signal,
    }).catch((error: Error) => error);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: () => controller.abort(),
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "submitted",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-previous" },
      }),
    );
    let steering!: Promise<void>;
    act(() => {
      steering = result.current.handleSendNow("queued-1");
    });
    await act(async () => {
      finishStart({
        ok: true,
        json: async () => ({
          runId: "run-starting",
          publicAccessToken: "synthetic",
        }),
      } as Response);
      await stream;
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    // Saving the old stream is still offline, but the new run is now known.
    expect(mockCancelDesktopRunLocally).toHaveBeenCalledWith(
      "chat-1",
      "run-starting",
    );
    await act(async () => {
      finishSave(null);
      await steering;
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        body: JSON.stringify({
          chatId: "chat-1",
          expectedTriggerRunId: "run-starting",
        }),
      }),
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["handleRegenerate", "handleEditMessage"] as const)(
    "%s rechecks a disconnect while stopping before mutating the task",
    async (method) => {
      let finishStop!: (value: null) => void;
      mockCancelStream.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finishStop = resolve;
          }),
      );
      const regenerate = jest.fn();
      const { result, rerender } = renderHook(
        (sendDisabledReason: string | undefined) =>
          useChatHandlers({
            chatId: "chat-1",
            messages,
            sendMessage: mockSendMessage,
            stop: mockStop,
            regenerate,
            setMessages: mockSetMessages,
            isExistingChat: true,
            status: "streaming",
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
            activeTriggerRunRef: { current: "run-1" },
            sendDisabledReason,
          }),
        { initialProps: undefined as string | undefined },
      );
      let action!: Promise<void>;
      act(() => {
        action =
          method === "handleEditMessage"
            ? result.current.handleEditMessage("user-1", "updated task")
            : result.current[method]();
      });
      rerender("Reconnect your computer");
      await act(async () => {
        finishStop(null);
        await action;
      });
      expect(mockSetTodos).not.toHaveBeenCalled();
      expect(mockSetMessages).not.toHaveBeenCalled();
      expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
      expect(mockRegenerateWithNewContent).not.toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
    },
  );

  it("preserves the draft and queue when a computer is disconnected", async () => {
    mockInput = "continue";
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        sendDisabledReason: "Reconnect your computer",
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(false);
      await result.current.handleSendNow("queued-1");
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
    expect(mockCancelStream).not.toHaveBeenCalled();
  });

  it.each(["send_now", "stop_and_send"])(
    "tracks %s while preserving the todo handoff",
    async (action) => {
      if (action === "stop_and_send") {
        mockQueueBehavior = "stop-and-send";
        mockInput = "Change direction";
      }
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: "run-1" },
        }),
      );

      await act(async () => {
        if (action === "send_now")
          await result.current.handleSendNow("queued-1");
        else
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any);
      });

      expect(mockCancelStream).toHaveBeenCalledWith({
        chatId: "chat-1",
        skipSave: undefined,
        todos,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/agent/cancel",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            chatId: "chat-1",
            expectedTriggerRunId: "run-1",
          }),
        }),
      );
      expect(mockCancelStream.mock.invocationCallOrder[0]).toBeLessThan(
        (globalThis.fetch as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(
        (globalThis.fetch as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(mockSendMessage.mock.invocationCallOrder[0]);
      if (action === "send_now")
        expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
      expect(mockCaptureCancellationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "agent_run_cancellation_settled",
          properties: expect.objectContaining({
            action,
            reason: "steer",
            triggerRunId: "run-1",
            outcome: "accepted",
          }),
        }),
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Change direction" }),
        expect.objectContaining({ body: expect.objectContaining({ todos }) }),
      );
    },
  );

  it("preserves persisted progress and todos when retrying an Agent task", async () => {
    const regenerate = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(mockSetTodos).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { isAutoContinue: true } }),
      expect.objectContaining({
        body: expect.objectContaining({ todos, isAutoContinue: true }),
      }),
    );
  });

  it("queues a manual message while an automatic continuation is submitted", async () => {
    mockInput = "Use the latest result";
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "submitted",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: jest.fn(),
      } as unknown as React.FormEvent);
    });

    expect(mockQueueMessage).toHaveBeenCalledWith("Use the latest result", []);
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "chat_user_submission",
      {
        definition_version: 1,
        mode: "agent",
        subscription_tier: "pro",
        queued: true,
      },
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not send or clear the composer when connectivity drops before submission", async () => {
    mockInput = "Keep this unsent draft";
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.handleSubmit({
        preventDefault: jest.fn(),
      } as unknown as React.FormEvent);
    });

    expect(accepted).toBe(false);
    expect(mockCaptureAuthenticatedEvent).not.toHaveBeenCalledWith(
      "chat_user_submission",
      expect.anything(),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
  });

  it("sends a queued message after the stream has already stopped", async () => {
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: true },
        activeTriggerRunRef: { current: undefined },
        resetAutoContinueCount: mockResetAutoContinueCount,
      }),
    );

    await act(async () => {
      await result.current.handleSendNow("queued-1");
    });

    expect(mockCancelStream).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockResetAutoContinueCount).toHaveBeenCalledTimes(1);
    expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Change direction" }),
      expect.any(Object),
    );
  });

  it("persists and applies cleaned todos when editing a stopped response", async () => {
    const regenerate = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: true },
        activeTriggerRunRef: { current: undefined },
        resetAutoContinueCount: mockResetAutoContinueCount,
      }),
    );

    await act(async () => {
      await result.current.handleEditMessage("user-1", "Edited task");
    });

    expect(mockRegenerateWithNewContent).toHaveBeenCalledWith({
      messageId: "user-1",
      newContent: "Edited task",
      fileIds: undefined,
      todos: [],
    });
    expect(mockResetAutoContinueCount).toHaveBeenCalledTimes(1);
    expect(mockSetTodos).toHaveBeenCalledWith([]);
    expect(regenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          todos: [],
          regenerate: true,
        }),
      }),
    );
  });

  it.each(["achieved", "paused", "settling", "cleared", "stale"])(
    "reruns an edited goal with its saved settings and fresh generation (%s)",
    async (state) => {
      const mockRegenerate = jest.fn();
      mockMessageQueue = [];
      const saved = {
        generation: state === "stale" ? 5 : 4,
        state,
        sandboxPreference: "e2b",
        permissionMode: "ask_approval",
        selectedModel: "auto",
      };
      jest.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: true,
          goal: state === "cleared" ? null : saved,
        }),
      } as Response);
      if (state === "settling") {
        jest.mocked(globalThis.fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            enabled: true,
            goal: { ...saved, activeRunId: "old-run" },
          }),
        } as Response);
      }
      mockRegenerateWithNewContent.mockResolvedValueOnce({ goalGeneration: 6 });
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages: messages.map((m) =>
            m.id === "user-1"
              ? { ...m, metadata: { goal: { sent: true } } }
              : m,
          ),
          sendMessage: mockSendMessage,
          regenerate: mockRegenerate,
          stop: mockStop,
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "ready",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          goalState: state,
          goalGeneration: 4,
        }),
      );
      if (state === "cleared" || state === "stale") {
        await act(async () => {
          await expect(
            result.current.handleEditMessage("user-1", "Updated goal"),
          ).rejects.toThrow();
        });
        expect(mockRegenerateWithNewContent).not.toHaveBeenCalled();
        expect(mockRegenerate).not.toHaveBeenCalled();
      } else {
        await act(async () => {
          await result.current.handleEditMessage("user-1", "Updated goal");
        });
        expect(mockRegenerateWithNewContent).toHaveBeenCalledWith(
          expect.objectContaining({
            newContent: "Updated goal",
            goalGeneration: 4,
          }),
        );
        expect(mockRegenerate).toHaveBeenCalledWith({
          body: expect.objectContaining({
            regenerate: true,
            goal: { action: "resume", expectedGeneration: 6 },
            agentPermissionMode: "ask_approval",
            selectedModel: "auto",
          }),
        });
      }
      mockRegenerateWithNewContent.mockReset();
    },
  );

  it("resets the continuation count before a manual continue", async () => {
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: true },
        activeTriggerRunRef: { current: undefined },
        resetAutoContinueCount: mockResetAutoContinueCount,
      }),
    );

    await act(async () => {
      await result.current.handleContinue();
    });

    expect(mockResetAutoContinueCount).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { isAutoContinue: true } }),
      expect.objectContaining({
        body: expect.not.objectContaining({
          isAutomaticContinuation: true,
        }),
      }),
    );
  });

  it.each(["stop", "send_now", "stop_and_send"])(
    "cancels through %s without replacing stored todos with a malformed snapshot",
    async (action) => {
      mockCurrentTodos = [
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `todo-${index}`,
          content: "Synthetic task",
          status: "pending",
        })),
        { id: "incomplete-todo", status: "in_progress" },
      ];
      mockCancelStream.mockImplementationOnce(async (...args: unknown[]) => {
        if (Object.hasOwn(args[0] as object, "todos")) {
          throw new Error("Synthetic invalid optional todo snapshot");
        }
        return null;
      });
      if (action === "stop_and_send") {
        mockQueueBehavior = "stop-and-send";
        mockInput = "Change direction";
      }
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
          activeTriggerRunRef: { current: "run-1" },
        }),
      );
      try {
        await act(async () => {
          if (action === "stop") await result.current.handleStop();
          else if (action === "send_now")
            await result.current.handleSendNow("queued-1");
          else
            await result.current.handleSubmit({
              preventDefault: jest.fn(),
            } as any);
        });
      } finally {
        errorSpy.mockRestore();
      }
      expect(mockCancelStream).toHaveBeenCalledWith({
        chatId: "chat-1",
        skipSave: undefined,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/agent/cancel",
        expect.objectContaining({ method: "POST" }),
      );
      if (action !== "stop") {
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockCancelStream.mock.invocationCallOrder[0]).toBeLessThan(
          (globalThis.fetch as jest.Mock).mock.invocationCallOrder[0],
        );
      }
      if (action === "send_now")
        expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
    },
  );

  it("keeps the queued message when the todo snapshot cannot be persisted", async () => {
    mockCancelStream.mockRejectedValueOnce(new Error("write failed"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: "run-1" },
      }),
    );

    try {
      await act(async () => {
        await result.current.handleSendNow("queued-1");
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("keeps the queued message and reconnects when cancellation is stale", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async () => {
        return {
          ok: false,
          status: 409,
          json: jest.fn(async () => ({
            canceled: false,
            reason: "stale_run",
            activeTriggerRunId: "run-2",
          })),
        } as unknown as Response;
      }),
    });
    const activeTriggerRunRef = { current: "run-1" };
    const hasManuallyStoppedRef = { current: false };
    const resumeActiveRun = jest.fn(async () => undefined);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef,
        activeTriggerRunRef,
        resumeActiveRun,
      }),
    );

    await act(async () => {
      await result.current.handleSendNow("queued-1");
    });

    expect(mockCaptureCancellationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_run_cancellation_settled",
        properties: expect.objectContaining({
          action: "send_now",
          triggerRunId: "run-1",
          outcome: "stale_run",
        }),
      }),
    );
    expect(activeTriggerRunRef.current).toBe("run-2");
    expect(hasManuallyStoppedRef.current).toBe(false);
    expect(resumeActiveRun).toHaveBeenCalledTimes(1);
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not clean local state or regenerate when the server rejects a stale edit", async () => {
    mockRegenerateWithNewContent.mockRejectedValueOnce({
      data: {
        code: "MESSAGE_NOT_EDITABLE",
        message: "Only the latest user message can be edited",
      },
    });
    const regenerate = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: undefined },
      }),
    );

    await act(async () => {
      await result.current.handleEditMessage("user-1", "Edited task");
    });

    expect(mockRegenerateWithNewContent).toHaveBeenCalledTimes(1);
    expect(mockSetTodos).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("does not clean local state or regenerate when the persisted edit fails", async () => {
    mockRegenerateWithNewContent.mockRejectedValueOnce(
      new Error("write failed"),
    );
    const regenerate = jest.fn();
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate,
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: undefined },
      }),
    );

    await act(async () => {
      await expect(
        result.current.handleEditMessage("user-1", "Edited task"),
      ).rejects.toThrow("write failed");
    });

    expect(mockSetTodos).not.toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("pauses an unclaimed goal before queueing a valid user message", async () => {
    mockInput = "Please check this first";
    mockMessageQueue = [];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ goal: { generation: 4 }, state: "paused" }),
    } as Response);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        goalState: "queued",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleSubmit({
          preventDefault: jest.fn(),
        } as unknown as React.FormEvent),
      ).toBe(true);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/agent-goal",
      expect.objectContaining({
        body: JSON.stringify({
          chatId: "chat-1",
          action: "pause",
          generation: 4,
        }),
      }),
    );
    expect(mockQueueMessage).toHaveBeenCalledWith(mockInput, []);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it.each(["ready", "streaming"] as const)(
    "does not pause a goal when an oversized message is rejected while %s",
    async (status) => {
      mockInput = "Oversized message";
      mockMessageQueue = [];
      const validation = await import("@/lib/utils/client-token-validation");
      jest
        .mocked(validation.getInputTokenLimitStatus)
        .mockResolvedValueOnce({ exceedsLimit: true, tokenCount: 999999 });
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status,
          goalState: "running",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as unknown as React.FormEvent),
        ).toBe(false);
      });
      expect(global.fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.anything(),
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
    },
  );

  const renderGoalReply = (goalState: string) =>
    renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        goalState,
        goalGeneration: 4,
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
  const savedBlockedGoal = {
    objective: "Create the requested file",
    criteria: ["File contains the chosen text"],
    generation: 4,
    state: "needs_input",
    sandboxPreference: "e2b",
    permissionMode: "ask_approval",
    selectedModel: "auto",
  };
  it.each(["/goal resume", "Use blue"])(
    "retains text and attachments when goal admission rejects %s",
    async (text) => {
      mockInput = text;
      mockAgentPermissionMode = "ask_approval";
      mockMessageQueue = [];
      mockUploadedFiles = [
        {
          file: new File(["blue"], "note.txt", { type: "text/plain" }),
          fileId: "file-1",
          uploaded: true,
          url: "https://example.com/note.txt",
        },
      ];
      jest.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true, goal: savedBlockedGoal }),
      } as Response);
      mockSendMessage.mockRejectedValueOnce(
        new Error("Goal changed after it was read"),
      );
      const { result } = renderGoalReply("needs_input");
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(mockClearUploadedFiles).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    },
  );
  it("clears an admitted goal draft when routing refreshes an empty attachment list", async () => {
    mockInput = "/goal Write the chosen word";
    mockMessageQueue = [];
    mockSendMessage.mockImplementationOnce(async () => {
      mockUploadedFiles = [];
    });
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(true);
    });
    expect(mockClearInput).toHaveBeenCalled();
    expect(mockClearUploadedFiles).toHaveBeenCalled();
  });
  it("fences explicit resume against edits after the saved goal is read", async () => {
    mockInput = "/goal resume";
    mockMessageQueue = [];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, goal: savedBlockedGoal }),
    } as Response);
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: jest.fn() } as any);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          goal: expect.objectContaining({
            action: "resume",
            expectedGeneration: 4,
          }),
        }),
      }),
    );
  });
  it("lets a Goal answer resume ahead of held queued work", async () => {
    mockInput = "Ordinary draft";
    mockAgentPermissionMode = "ask_approval";
    mockMessageQueue = [
      { id: "held-followup", text: "Later task", timestamp: Date.now() },
    ];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, goal: savedBlockedGoal }),
    } as Response);
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      expect(
        await result.current.handleSubmit(
          { preventDefault: jest.fn() } as any,
          "Beta",
          true,
        ),
      ).toBe(true);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Beta" }),
      expect.objectContaining({
        body: expect.objectContaining({
          goal: {
            action: "resume",
            expectedGeneration: 4,
            resumeOnReply: true,
          },
        }),
      }),
    );
    expect(mockMessageQueue).toHaveLength(1);
    expect(mockClearInput).not.toHaveBeenCalled();
  });

  it("explicitly resumes a blocked Goal without sending or deleting held work", async () => {
    mockInput = "/goal resume";
    mockMessageQueue = [
      { id: "held", text: "Later task", timestamp: Date.now() },
    ];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: true,
        goal: { ...savedBlockedGoal, state: "blocked" },
      }),
    } as Response);
    const { result } = renderGoalReply("blocked");
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(true);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          goal: { action: "resume", expectedGeneration: 4 },
        }),
      }),
    );
    expect(mockMessageQueue).toHaveLength(1);
    expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
  });

  it("treats a structured Goal answer as literal text even when it resembles a command", async () => {
    mockInput = "Unsent ordinary draft";
    mockAgentPermissionMode = "ask_approval";
    mockMessageQueue = [];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, goal: savedBlockedGoal }),
    } as Response);
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      expect(
        await result.current.handleSubmit(
          { preventDefault: jest.fn() } as any,
          "/goal clear",
          true,
        ),
      ).toBe(true);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/goal clear" }),
      expect.objectContaining({
        body: expect.objectContaining({
          goal: {
            action: "resume",
            expectedGeneration: 4,
            resumeOnReply: true,
          },
        }),
      }),
    );
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
  });

  it.each(["needs_input", "blocked"])(
    "resumes a %s goal with the user's actual reply and original permissions",
    async (state) => {
      mockInput = "Use blue";
      mockAgentPermissionMode = "ask_approval";
      mockMessageQueue = [];
      jest.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: true,
          goal: { ...savedBlockedGoal, state },
        }),
      } as Response);
      const { result } = renderGoalReply(state);
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(true);
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Use blue" }),
        expect.objectContaining({
          body: expect.objectContaining({
            goal: {
              action: "resume",
              expectedGeneration: 4,
              resumeOnReply: true,
            },
            agentPermissionMode: "ask_approval",
            selectedModel: "auto",
            sandboxPreference: "e2b",
          }),
        }),
      );
      expect(mockClearInput).toHaveBeenCalled();
    },
  );
  it.each(["paused", "achieved", "canceled", "usage_exhausted", "failed"])(
    "keeps an ordinary reply separate from a %s goal",
    async (state) => {
      mockInput = "A separate question";
      mockMessageQueue = [];
      const { result } = renderGoalReply(state);
      await act(async () => {
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any);
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: mockInput }),
        expect.objectContaining({
          body: expect.not.objectContaining({ goal: expect.anything() }),
        }),
      );
    },
  );
  it.each([
    { ...savedBlockedGoal, generation: 5 },
    { ...savedBlockedGoal, state: "paused" },
    { ...savedBlockedGoal, activeRunId: "another-run" },
    null,
  ])(
    "preserves a reply when the blocked goal changed before submission",
    async (goal) => {
      mockInput = "Use blue";
      mockAgentPermissionMode = "ask_approval";
      mockMessageQueue = [];
      jest.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true, goal }),
      } as Response);
      const { result } = renderGoalReply("needs_input");
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
    },
  );
  it("does not resume a blocked Agent goal from Ask", async () => {
    mockChatMode = "ask";
    mockInput = "A separate question";
    mockMessageQueue = [];
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: jest.fn() } as any);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: mockInput }),
      expect.objectContaining({
        body: expect.not.objectContaining({ goal: expect.anything() }),
      }),
    );
  });

  it("allows ordinary chat when goal access is disabled", async () => {
    mockInput = "A separate question";
    mockMessageQueue = [];
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false, goal: savedBlockedGoal }),
    } as Response);
    const { result } = renderGoalReply("needs_input");
    await act(async () => {
      expect(
        await result.current.handleSubmit({ preventDefault: jest.fn() } as any),
      ).toBe(true);
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: mockInput }),
      expect.objectContaining({
        body: expect.not.objectContaining({ goal: expect.anything() }),
      }),
    );
  });
  it.each([
    { permissionMode: "full_access", sandboxPreference: "e2b" },
    { permissionMode: "ask_approval", sandboxPreference: "desktop" },
  ])(
    "does not silently change permissions or machine when resuming from a reply",
    async (settings) => {
      mockInput = "Use blue";
      mockMessageQueue = [];
      mockAgentPermissionMode = "ask_approval";
      jest.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: true,
          goal: { ...savedBlockedGoal, ...settings },
        }),
      } as Response);
      const { result } = renderGoalReply("needs_input");
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
    },
  );

  it("keeps the draft when the saved objective exceeds the input budget", async () => {
    mockInput = "/goal resume";
    mockMessageQueue = [];
    const validation = await import("@/lib/utils/client-token-validation");
    jest
      .mocked(validation.getInputTokenLimitStatus)
      .mockImplementationOnce(async (text) =>
        text.includes("Updated file goal")
          ? { exceedsLimit: true, tokenCount: 999999 }
          : { exceedsLimit: false },
      );
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        goal: {
          objective: "Updated file goal",
          criteria: ["Verify the new file"],
          sandboxPreference: "e2b",
          permissionMode: "full_access",
          selectedModel: "hackerai-standard",
        },
      }),
    } as Response);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    try {
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as unknown as React.FormEvent),
        ).toBe(false);
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
    } finally {
      jest.mocked(validation.getInputTokenLimitStatus).mockClear();
    }
  });

  it.each(["/goal", "/goal status", "/goal pause", "/goal clear"])(
    "handles %s in an unsaved chat without a backend request or model run",
    async (command) => {
      mockInput = command;
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "new-chat",
          messages: [],
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: false,
          status: "ready",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      let accepted: boolean | undefined;
      await act(async () => {
        accepted = await result.current.handleSubmit({
          preventDefault: jest.fn(),
        } as unknown as React.FormEvent);
      });
      expect(accepted).toBe(true);
      expect(mockClearInput).toHaveBeenCalledTimes(1);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockQueueMessage).not.toHaveBeenCalled();
    },
  );

  it("compacts an aggregate stopped snapshot without changing the live response", async () => {
    const { getDocumentSize } = await import("convex/values");
    const toolParts = Array.from({ length: 260 }, (_, index) => ({
      type: "tool-run_terminal_cmd",
      toolCallId: `synthetic-call-${index}`,
      state: "output-available",
      input: { command: `printf synthetic-${index}` },
      output: { output: "synthetic-output-" + "x".repeat(6000), exitCode: 0 },
    }));
    const history = [
      messages[0],
      {
        id: "long-stopped-assistant",
        role: "assistant",
        parts: [...toolParts, { type: "text", text: "Keep the final answer." }],
        metadata: { mode: "ask", generationStartedAt: Date.now() - 1000 },
      },
    ] as ChatMessage[];
    const originalParts = JSON.stringify(history[1].parts);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: history,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await import("@/lib/chat/compaction/prune-tool-outputs");
    });
    await act(async () => {
      expect(
        await result.current.handleStop({ requireSavedResponse: true }),
      ).toBe(true);
    });
    expect(mockSaveAssistantMessage).toHaveBeenCalledTimes(1);
    const saved = mockSaveAssistantMessage.mock.calls[0].at(0) as unknown as {
      id: string;
      parts: ChatMessage["parts"];
      mode: string;
      generationStartedAt: number;
      generationTimeMs: number;
    };
    expect(new TextEncoder().encode(originalParts).byteLength).toBeGreaterThan(
      1024 * 1024,
    );
    expect(
      getDocumentSize({
        ...saved,
        chat_id: "chat-1",
        user_id: "test-user",
        update_time: Date.now(),
      }),
    ).toBeLessThan(960 * 1024);
    expect(saved.parts).toContainEqual({
      type: "text",
      text: "Keep the final answer.",
    });
    expect(saved).toMatchObject({
      id: history[1].id,
      mode: "ask",
      generationStartedAt: history[1].metadata?.generationStartedAt,
      generationTimeMs: expect.any(Number),
    });
    expect(
      saved.parts
        .filter((part) => part.type === "tool-run_terminal_cmd")
        .map((part: any) => part.toolCallId),
    ).toEqual(toolParts.map((part) => part.toolCallId));
    expect(JSON.stringify(history[1].parts)).toBe(originalParts);
    expect(mockSetMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: history[1].id, parts: history[1].parts }),
      ]),
    );
    expect(mockCancelStream).toHaveBeenCalledTimes(1);
    expect(mockSaveAssistantMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelStream.mock.invocationCallOrder[0],
    );
    const outcomes = mockCaptureCancellationEvent.mock.calls
      .map(
        ([input]) =>
          input as { event: string; properties: Record<string, unknown> },
      )
      .filter((input) => input.event === "chat_stop_snapshot_save_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].properties).toMatchObject({
      diagnostic_version: 1,
      preparation_outcome: "compacted",
      save_outcome: "acknowledged",
      part_count: 261,
      before_size_bytes: expect.any(Number),
      after_size_bytes: expect.any(Number),
    });
    expect(JSON.stringify(outcomes)).not.toMatch(
      /synthetic|private|final answer|chat-1|long-stopped/,
    );
  });

  it("bounds numeric-heavy Stop snapshots using Convex size rather than JSON", async () => {
    const { getConvexSize } = await import("convex/values");
    const parts = Array.from({ length: 14 }, () => ({
      type: "data-value",
      data: Array(7900).fill(0),
    })) as ChatMessage["parts"];
    expect(JSON.stringify(parts).length).toBeLessThan(850 * 1024);
    expect(getConvexSize(parts as any)).toBeGreaterThan(960 * 1024);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [
          messages[0],
          { id: "numeric-stop", role: "assistant", parts },
        ],
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await import("@/lib/chat/compaction/prune-tool-outputs");
    });
    await act(async () => {
      expect(
        await result.current.handleStop({ requireSavedResponse: true }),
      ).toBe(true);
    });
    const saved = mockSaveAssistantMessage.mock.calls[0].at(0) as unknown as {
      parts: ChatMessage["parts"];
    };
    expect(getConvexSize(saved.parts as any)).toBeLessThanOrEqual(850 * 1024);
    expect(saved.parts).toHaveLength(parts.length);
    expect(saved.parts.at(-1)).toEqual(parts.at(-1));
    expect(parts[0]).toEqual({ type: "data-value", data: Array(7900).fill(0) });
  });

  it("preserves a Convex-sized snapshot even when JSON escaping inflates its estimate", async () => {
    const parts = [
      { type: "text", text: '"'.repeat(500_000) },
    ] as ChatMessage["parts"];
    expect(JSON.stringify(parts).length).toBeGreaterThan(850 * 1024);
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [
          messages[0],
          { id: "quoted-stop", role: "assistant", parts },
        ],
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      await result.current.handleStop();
    });
    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parts }),
    );
    expect(mockSaveAssistantMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelStream.mock.invocationCallOrder[0],
    );
  });

  it.each(["rejected", "analytics_unavailable"] as const)(
    "keeps oversized Stop outcomes independent of %s",
    async (scenario) => {
      const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT =
        scenario === "rejected" ? "F".repeat(40) : "private-invalid-build";
      if (scenario === "rejected")
        mockSaveAssistantMessage.mockRejectedValueOnce(
          new Error("private synthetic rejection"),
        );
      else
        mockCaptureCancellationEvent.mockImplementation(
          (...args: unknown[]) => {
            if (
              (args[0] as { event?: string })?.event ===
              "chat_stop_snapshot_save_outcome"
            )
              throw new Error("analytics unavailable");
          },
        );
      try {
        const parts = Array.from({ length: 14 }, () => ({
          type: "data-value",
          data: Array(7900).fill(0),
        })) as ChatMessage["parts"];
        const { result } = renderHook(() =>
          useChatHandlers({
            chatId: "chat-1",
            messages: [
              messages[0],
              { id: "private-snapshot", role: "assistant", parts },
            ],
            sendMessage: mockSendMessage,
            stop: mockStop,
            regenerate: jest.fn(),
            setMessages: mockSetMessages,
            isExistingChat: true,
            status: "streaming",
            isSendingNowRef: { current: false },
            hasManuallyStoppedRef: { current: false },
          }),
        );
        await act(async () => {
          await import("@/lib/chat/compaction/prune-tool-outputs");
        });
        await act(async () => {
          expect(
            await result.current.handleStop({ requireSavedResponse: true }),
          ).toBe(scenario !== "rejected");
        });
        expect(mockSaveAssistantMessage).toHaveBeenCalledTimes(1);
        expect(mockCancelStream).toHaveBeenCalledTimes(1);
        const outcomes = mockCaptureCancellationEvent.mock.calls
          .map(
            ([input]) =>
              input as { event: string; properties: Record<string, unknown> },
          )
          .filter((input) => input.event === "chat_stop_snapshot_save_outcome");
        expect(outcomes).toHaveLength(1);
        if (scenario === "analytics_unavailable") {
          const index = mockCaptureCancellationEvent.mock.calls.findIndex(
            ([input]) =>
              (input as { event?: string })?.event ===
              "chat_stop_snapshot_save_outcome",
          );
          expect(mockCaptureCancellationEvent.mock.results[index].type).toBe(
            "throw",
          );
        }
        expect(outcomes[0].properties).toMatchObject({
          save_outcome: scenario === "rejected" ? "rejected" : "acknowledged",
          frontend_build_commit:
            scenario === "rejected" ? "f".repeat(40) : "unknown",
        });
        expect(Object.keys(outcomes[0].properties as object).sort()).toEqual(
          [
            "diagnostic_version",
            "preparation_outcome",
            "before_size_bytes",
            "after_size_bytes",
            "part_count",
            "pruned_count",
            "save_outcome",
            "frontend_build_commit",
            ...(scenario === "rejected" ? ["save_error_code"] : []),
          ].sort(),
        );
        expect(JSON.stringify(outcomes)).not.toMatch(
          /private|chat-1|synthetic/,
        );
      } finally {
        mockCaptureCancellationEvent.mockReset();
        if (originalBuild === undefined)
          delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
        else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
      }
    },
  );

  it.each([false, true])(
    "never waits for a compactor chunk before Ask cancellation (preloaded=%s)",
    async (preloaded) => {
      mockChatMode = "ask";
      const parts = Array.from({ length: 14 }, () => ({
        type: "data-value",
        data: Array(7900).fill(0),
      })) as ChatMessage["parts"];
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages: [
            messages[0],
            { id: "ask-large-stop", role: "assistant", parts },
          ],
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      if (preloaded)
        await act(async () => {
          await import("@/lib/chat/compaction/prune-tool-outputs");
        });
      let stopped!: Promise<boolean>;
      act(() => {
        stopped = result.current.handleStop({ requireSavedResponse: true });
        expect(mockSaveAssistantMessage).toHaveBeenCalledTimes(1);
        expect(mockCancelStream).toHaveBeenCalledTimes(1);
        expect(
          mockSaveAssistantMessage.mock.invocationCallOrder[0],
        ).toBeLessThan(mockCancelStream.mock.invocationCallOrder[0]);
      });
      await act(async () => {
        expect(await stopped).toBe(true);
      });
      const outcomes = mockCaptureCancellationEvent.mock.calls
        .map(
          ([input]) =>
            input as { event: string; properties: Record<string, unknown> },
        )
        .filter((input) => input.event === "chat_stop_snapshot_save_outcome");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].properties.preparation_outcome).toBe(
        preloaded ? "compacted" : "unavailable",
      );
    },
  );

  it("preserves small Convex-native values and cancellation", async () => {
    const parts = [
      { type: "text", text: "small response" },
      { type: "data-value", data: { counter: 1n } },
    ] as ChatMessage["parts"];
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: [
          messages[0],
          { id: "native-values", role: "assistant", parts },
        ],
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    await act(async () => {
      expect(
        await result.current.handleStop({ requireSavedResponse: true }),
      ).toBe(true);
    });
    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "native-values", parts }),
    );
    expect(
      mockCaptureCancellationEvent.mock.calls
        .map(([input]) => input as { event: string })
        .filter((input) => input.event === "chat_stop_snapshot_save_outcome"),
    ).toHaveLength(0);
    expect(mockCancelStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "messages:saveAssistantMessage",
      "0123456789abcdef",
      "MESSAGE_TOO_LARGE",
      "0123456789abcdef",
    ],
    ["messages:other", "0123456789abcdef", "MESSAGE_TOO_LARGE", undefined],
    [
      "messages:saveAssistantMessage",
      "0123456789ABCDEf",
      "MESSAGE_TOO_LARGE",
      undefined,
    ],
    [
      "messages:saveAssistantMessage",
      "0123456789abcdef0",
      "MESSAGE_TOO_LARGE",
      undefined,
    ],
    [
      "messages:saveAssistantMessage",
      "0123456789abcdef",
      "PRIVATE_CODE_CANARY",
      "0123456789abcdef",
    ],
  ])(
    "correlates rejected Stop snapshots without copying private errors (%s/%s/%s)",
    async (fn, marker, code, expectedId) => {
      const error = new ConvexError({
        code,
        content: "PRIVATE_CONTENT_CANARY",
      });
      error.message = `[CONVEX M(${fn})] [Request ID: ${marker}] PRIVATE_MESSAGE_CANARY`;
      mockSaveAssistantMessage.mockRejectedValueOnce(error);
      const { result } = renderHook(() =>
        useChatHandlers({
          chatId: "chat-1",
          messages,
          sendMessage: mockSendMessage,
          stop: mockStop,
          regenerate: jest.fn(),
          setMessages: mockSetMessages,
          isExistingChat: true,
          status: "streaming",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      );
      await act(async () => {
        expect(
          await result.current.handleStop({ requireSavedResponse: true }),
        ).toBe(false);
      });
      const outcomes = mockCaptureCancellationEvent.mock.calls
        .map(
          ([input]) =>
            input as { event: string; properties: Record<string, unknown> },
        )
        .filter((input) => input.event === "chat_stop_snapshot_save_outcome");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].properties).toMatchObject({
        diagnostic_version: 1,
        preparation_outcome: "not_needed",
        save_outcome: "rejected",
        save_error_code:
          code === "MESSAGE_TOO_LARGE" ? "message_too_large" : "other",
        frontend_build_commit: expect.any(String),
      });
      expect(outcomes[0].properties.convex_request_id).toBe(expectedId);
      expect(Object.keys(outcomes[0].properties).sort()).toEqual(
        [
          "diagnostic_version",
          "preparation_outcome",
          "save_outcome",
          "save_error_code",
          "frontend_build_commit",
          ...(expectedId ? ["convex_request_id"] : []),
        ].sort(),
      );
      expect(JSON.stringify(outcomes)).not.toMatch(/CANARY|chat-1/);
      expect(mockSaveAssistantMessage).toHaveBeenCalledTimes(1);
      expect(mockCancelStream).toHaveBeenCalledTimes(1);
      expect(mockSaveAssistantMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockCancelStream.mock.invocationCallOrder[0],
      );
    },
  );

  it("reports failure to goal controls when the partial response could not be saved", async () => {
    mockSaveAssistantMessage.mockRejectedValueOnce(
      new Error("Synthetic save failure"),
    );
    const { result } = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages,
        sendMessage: mockSendMessage,
        stop: mockStop,
        regenerate: jest.fn(),
        setMessages: mockSetMessages,
        isExistingChat: true,
        status: "streaming",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
        activeTriggerRunRef: { current: undefined },
      }),
    );
    let stopped: boolean | undefined;
    await act(async () => {
      stopped = await result.current.handleStop({ requireSavedResponse: true });
    });
    expect(mockSaveAssistantMessage).toHaveBeenCalled();
    expect(stopped).toBe(false);
  });
});

describe("Agent recovery ordering", () => {
  const recoveryProps = () => ({
    chatId: "chat-1",
    messages,
    sendMessage: mockSendMessage,
    stop: mockStop,
    regenerate: jest.fn(),
    setMessages: mockSetMessages,
    isExistingChat: true,
    status: "error" as const,
    isSendingNowRef: { current: false },
    hasManuallyStoppedRef: { current: false },
    resumeActiveRun: jest.fn(async () => {}),
  });
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async () => ({ status: 204 }) as Response),
    });
  });

  it("reconnects a live worker without canceling or starting another run", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ status: 200 } as Response);
    const props = recoveryProps();
    const { result } = renderHook(() => useChatHandlers(props));
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(props.resumeActiveRun).toHaveBeenCalledTimes(1);
    expect(mockCancelStream).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("waits for saved progress, preserves model and billing choices, and coalesces clicks", async () => {
    let finishSave!: () => void;
    const save = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const props = { ...recoveryProps(), prepareAgentRecovery: () => save };
    const { result } = renderHook(() => useChatHandlers(props));
    let retry!: Promise<void>;
    act(() => {
      retry = result.current.handleRetry({ selectedModel: "auto" });
    });
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    await act(async () => {
      finishSave();
      await retry;
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          selectedModel: "auto",
          todos,
          sandboxPreference: "e2b",
        }),
      }),
    );
    expect(props.regenerate).not.toHaveBeenCalled();
  });

  it.each(["preflight", "save"])(
    "preserves history when %s fails",
    async (failure) => {
      if (failure === "preflight")
        jest.mocked(fetch).mockResolvedValueOnce({ status: 503 } as Response);
      const props = {
        ...recoveryProps(),
        prepareAgentRecovery: async () => {
          if (failure === "save") throw new Error("offline");
        },
      };
      const { result } = renderHook(() => useChatHandlers(props));
      await act(async () => {
        await result.current.handleRetry();
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
      expect(mockSetTodos).not.toHaveBeenCalled();
      expect(mockSetMessages).not.toHaveBeenCalled();
    },
  );

  it("continues from persisted history with an uncertainty warning after a terminal save rejection", async () => {
    const props = {
      ...recoveryProps(),
      prepareAgentRecovery: async () => true,
    };
    const { result } = renderHook(() => useChatHandlers(props));
    await act(async () => {
      await result.current.handleContinue();
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Some recent streamed output could not be saved",
        ),
      }),
      expect.anything(),
    );
    expect(mockDeleteLastAssistantMessage).not.toHaveBeenCalled();
  });

  it("does not send into another chat after navigation during recovery", async () => {
    let finishSave!: () => void;
    const save = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const props = recoveryProps();
    const { result, rerender } = renderHook(
      ({ chatId }) =>
        useChatHandlers({ ...props, chatId, prepareAgentRecovery: () => save }),
      { initialProps: { chatId: "chat-1" } },
    );
    let retry!: Promise<void>;
    act(() => {
      retry = result.current.handleRetry();
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ chatId: "chat-2" });
    await act(async () => {
      finishSave();
      await retry;
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
