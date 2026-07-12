import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import type { ChatMessage, SelectedModel } from "@/types";

const mockRegenerate = jest.fn();
const mockSendMessage = jest.fn();
const mockSetMessages = jest.fn();
let mockSelectedModel: SelectedModel = "hackerai-standard";
let mockTemporaryChatsEnabled = true;
const originalFetch = globalThis.fetch;

jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(async () => undefined),
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    input: "",
    uploadedFiles: [],
    chatMode: "ask",
    clearInput: jest.fn(),
    clearUploadedFiles: jest.fn(),
    todos: [],
    setTodos: jest.fn(),
    isUploadingFiles: false,
    subscription: "pro",
    temporaryChatsEnabled: mockTemporaryChatsEnabled,
    queueMessage: jest.fn(),
    messageQueue: [],
    removeQueuedMessage: jest.fn(),
    queueBehavior: "queue",
    sandboxPreference: "e2b",
    selectedModel: mockSelectedModel,
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
    mockTemporaryChatsEnabled = true;
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

  it.each([
    ["temporary", true],
    ["persisted", false],
  ])(
    "uses the latest chat input model for %s chats from a previously rendered regenerate callback",
    async (_chatType, temporaryChatsEnabled) => {
      mockTemporaryChatsEnabled = temporaryChatsEnabled;
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
    },
  );

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

  it("cancels the active Trigger session before regenerating", async () => {
    mockTemporaryChatsEnabled = false;
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
        body: JSON.stringify({ chatId: "chat-1" }),
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
    mockTemporaryChatsEnabled = false;
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
        body: JSON.stringify({ chatId: "chat-1" }),
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

  it("cancels a restored Trigger run even when the current mode is ask", async () => {
    mockTemporaryChatsEnabled = false;
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

    await act(async () => {
      await result.current.handleStop();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chatId: "chat-1" }),
      }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
