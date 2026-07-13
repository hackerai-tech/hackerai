import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ChatMessage, SidebarContent } from "@/types";

const mockRegenerate = jest.fn();
const mockSetMessages = jest.fn();
const mockOpenSidebar = jest.fn();
const mockCloseSidebar = jest.fn();
let mockSidebarOpen = false;
let mockSidebarContent: SidebarContent | null = null;

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
    temporaryChatsEnabled: true,
    queueMessage: jest.fn(),
    messageQueue: [],
    removeQueuedMessage: jest.fn(),
    queueBehavior: "queue",
    sandboxPreference: "e2b",
    agentPermissionMode: "full_access",
    selectedModel: "hackerai-standard",
    sidebarOpen: mockSidebarOpen,
    sidebarContent: mockSidebarContent,
    openSidebar: mockOpenSidebar,
    closeSidebar: mockCloseSidebar,
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

const userMessage = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const fileToolMessage = (
  id: string,
  toolCallId: string,
  content: string,
): ChatMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "tool-file",
      toolCallId,
      state: "output-available",
      input: { action: "read", path: "/tmp/result.txt" },
      output: { originalContent: content },
    },
  ],
});

const renderHandlers = (messages: ChatMessage[]) =>
  renderHook(() =>
    useChatHandlers({
      chatId: "chat-1",
      messages,
      sendMessage: jest.fn(),
      stop: jest.fn(),
      regenerate: mockRegenerate,
      setMessages: mockSetMessages,
      isExistingChat: false,
      status: "ready",
      isSendingNowRef: { current: false },
      hasManuallyStoppedRef: { current: false },
    }),
  );

describe("useChatHandlers regeneration sidebar reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSidebarOpen = false;
    mockSidebarContent = null;
  });

  it("selects the latest surviving tool when regeneration removes the open tool", async () => {
    const messages = [
      userMessage("user-1", "First question"),
      fileToolMessage("assistant-1", "tool-previous", "previous output"),
      userMessage("user-2", "Second question"),
      fileToolMessage("assistant-2", "tool-removed", "removed output"),
    ];
    const { result, rerender } = renderHandlers(messages);
    const regenerateFromRenderedMessage = result.current.handleRegenerate;

    mockSidebarOpen = true;
    mockSidebarContent = {
      path: "/tmp/result.txt",
      content: "removed output",
      action: "reading",
      toolCallId: "tool-removed",
    };
    rerender();

    await act(async () => {
      await regenerateFromRenderedMessage();
    });

    expect(mockOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tool-previous",
        content: "previous output",
      }),
    );
    expect(mockCloseSidebar).not.toHaveBeenCalled();
  });

  it("closes the sidebar when no tool remains before the regenerated response", async () => {
    const messages = [
      userMessage("user-1", "Question"),
      fileToolMessage("assistant-1", "tool-removed", "removed output"),
    ];
    mockSidebarOpen = true;
    mockSidebarContent = {
      path: "/tmp/result.txt",
      content: "removed output",
      action: "reading",
      toolCallId: "tool-removed",
    };
    const { result } = renderHandlers(messages);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(mockCloseSidebar).toHaveBeenCalledTimes(1);
    expect(mockOpenSidebar).not.toHaveBeenCalled();
  });
});
