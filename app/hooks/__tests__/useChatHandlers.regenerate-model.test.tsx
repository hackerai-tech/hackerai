import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import type { ChatMessage, SelectedModel } from "@/types";

const mockRegenerate = jest.fn();
const mockSetMessages = jest.fn();
let mockSelectedModel: SelectedModel = "hackerai-standard";

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
  });

  it("uses the latest chat input model from a previously rendered regenerate callback", async () => {
    const { result, rerender } = renderHook(() =>
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
});
