import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ChatMessage, QueuedMessage, QueueBehavior, Todo } from "@/types";
import { fetchAgentLongStream } from "@/lib/chat/agent-long-transport";

jest.mock("@/lib/utils/client-token-validation", () => ({
  ...jest.requireActual<typeof import("@/lib/utils/client-token-validation")>(
    "@/lib/utils/client-token-validation",
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

const mockCancelStream = jest.fn(async () => null);
const mockSaveAssistantMessage = jest.fn(async () => null);
const mockDeleteLastAssistantMessage = jest.fn(async () => null);
const mockRegenerateWithNewContent = jest.fn(async () => null);
const mockRemoveQueuedMessage = jest.fn();
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

jest.mock("@/convex/_generated/api", () => ({
  api: {
    chatStreams: { cancelStreamFromClient: "cancelStreamFromClient" },
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
    getInput: () => mockInput,
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: mockChatMode,
    clearInput: mockClearInput,
    clearUploadedFiles: mockClearUploadedFiles,
    todos,
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
    sandboxPreference: mockSandboxPreference,
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
    mockQueueMessage.mockReturnValue("queued-1");
    mockInput = "";
    mockUploadedFiles = [];
    mockSandboxPreference = "e2b";
    mockChatMode = "agent";
    mockQueueBehavior = "queue";
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

  const renderSummarySteer = () => {
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
          activeTriggerRunRef: { current: "run-1" },
        }),
      {
        initialProps: {
          isSummarizing: true,
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
