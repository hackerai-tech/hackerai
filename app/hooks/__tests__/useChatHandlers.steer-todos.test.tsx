import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ChatMessage, Todo } from "@/types";

const mockCancelStream = jest.fn(async () => null);
const mockCancelTempStream = jest.fn(async () => null);
const mockSaveAssistantMessage = jest.fn(async () => null);
const mockDeleteLastAssistantMessage = jest.fn(async () => null);
const mockRegenerateWithNewContent = jest.fn(async () => null);
const mockRemoveQueuedMessage = jest.fn();
const mockSendMessage = jest.fn(async () => undefined);
const mockStop = jest.fn();
const mockSetMessages = jest.fn();

const todos: Todo[] = [
  {
    id: "todo-1",
    content: "Keep this task",
    status: "in_progress",
    sourceMessageId: "assistant-1",
  },
];

jest.mock("@/convex/_generated/api", () => ({
  api: {
    chatStreams: { cancelStreamFromClient: "cancelStreamFromClient" },
    messages: {
      deleteLastAssistantMessage: "deleteLastAssistantMessage",
      regenerateWithNewContent: "regenerateWithNewContent",
      saveAssistantMessage: "saveAssistantMessage",
    },
    tempStreams: { cancelTempStreamFromClient: "cancelTempStreamFromClient" },
  },
}));

jest.mock("convex/react", () => ({
  useMutation: (mutation: string) => {
    switch (mutation) {
      case "cancelStreamFromClient":
        return mockCancelStream;
      case "cancelTempStreamFromClient":
        return mockCancelTempStream;
      case "saveAssistantMessage":
        return mockSaveAssistantMessage;
      case "deleteLastAssistantMessage":
        return mockDeleteLastAssistantMessage;
      case "regenerateWithNewContent":
        return mockRegenerateWithNewContent;
      default:
        throw new Error(`Unexpected mutation: ${mutation}`);
    }
  },
}));

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    input: "",
    uploadedFiles: [],
    chatMode: "agent",
    clearInput: jest.fn(),
    clearUploadedFiles: jest.fn(),
    todos,
    setTodos: jest.fn(),
    isUploadingFiles: false,
    subscription: "pro",
    temporaryChatsEnabled: false,
    queueMessage: jest.fn(),
    messageQueue: [
      {
        id: "queued-1",
        text: "Change direction",
        files: [],
        timestamp: 123,
      },
    ],
    removeQueuedMessage: mockRemoveQueuedMessage,
    queueBehavior: "queue",
    sandboxPreference: "e2b",
    agentPermissionMode: "full_access",
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
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: jest.fn(async () => ({ ok: true, status: 200 }) as Response),
    });
  });

  it("persists todos and cancels the active run before sending the queued message", async () => {
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
      await result.current.handleSendNow("queued-1");
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
        body: JSON.stringify({ chatId: "chat-1" }),
      }),
    );
    expect(mockCancelStream.mock.invocationCallOrder[0]).toBeLessThan(
      (globalThis.fetch as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(
      (globalThis.fetch as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(mockSendMessage.mock.invocationCallOrder[0]);
    expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Change direction" }),
      expect.objectContaining({ body: expect.objectContaining({ todos }) }),
    );
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
      }),
    );

    await act(async () => {
      await result.current.handleSendNow("queued-1");
    });

    expect(mockCancelStream).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Change direction" }),
      expect.any(Object),
    );
  });

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
});
