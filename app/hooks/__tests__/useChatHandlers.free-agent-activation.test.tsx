import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { toast } from "sonner";
import type { ChatMessage } from "@/types";

jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => "test-user",
  captureQueuedAuthenticatedEvent: jest.fn(),
  captureAuthenticatedEvent: jest.fn(),
}));

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

// Every Convex mutation (including deleteLastAssistantMessage) lands here.
const mockMutation = jest.fn(async (_args?: unknown) => null);
jest.mock("convex/react", () => ({
  useMutation: () => mockMutation,
}));

const mockSendMessage = jest.fn(async () => undefined);
const mockClearInput = jest.fn();
const mockClearUploadedFiles = jest.fn();
const mockSetTodos = jest.fn();
const savedTodos = [
  {
    id: "todo-1",
    content: "Saved todo",
    status: "completed",
    sourceMessageId: "assistant-1",
  },
];
let mockInput = "";
let mockUploadedFiles: unknown[] = [];
// GlobalState sets this for the test variant and for an unknown status.
let mockAwaitsAdmission = true;
let mockMessageQueue: unknown[] = [];
const mockRemoveQueuedMessage = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    getInput: () => mockInput,
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: "ask",
    clearInput: mockClearInput,
    clearUploadedFiles: mockClearUploadedFiles,
    todos: savedTodos,
    setTodos: mockSetTodos,
    isUploadingFiles: false,
    subscription: "free",
    queueMessage: jest.fn(),
    messageQueue: mockMessageQueue,
    removeQueuedMessage: mockRemoveQueuedMessage,
    queueBehavior: "queue",
    sandboxPreference: "e2b",
    agentPermissionMode: "ask_approval",
    selectedModel: "auto",
    sidebarOpen: false,
    sidebarContent: null,
    openSidebar: jest.fn(),
    closeSidebar: jest.fn(),
    freeAskAwaitsAdmission: mockAwaitsAdmission,
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

const attachment = {
  file: new File(["scope"], "scope.txt", { type: "text/plain" }),
  uploaded: true,
  fileId: "file-1",
  tokens: 10,
};

function renderHandlers(
  sendAdmittedMessage: (
    message: unknown,
    options?: unknown,
    kind?: "goal" | "ask",
  ) => Promise<void>,
  chatId = "chat-1",
  hasManuallyStoppedRef = { current: false },
  onExplicitSend?: () => void,
) {
  return renderHook(
    ({ id }) =>
      useChatHandlers({
        chatId: id,
        messages: [] as ChatMessage[],
        sendMessage: mockSendMessage,
        sendAdmittedMessage,
        stop: jest.fn(),
        regenerate: jest.fn(),
        setMessages: jest.fn(),
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef,
        onExplicitSend,
      }),
    { initialProps: { id: chatId } },
  );
}

const submit = (handlers: { handleSubmit: (e: never) => Promise<boolean> }) =>
  handlers.handleSubmit({ preventDefault: jest.fn() } as never);

describe("useChatHandlers free Agent activation admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInput = "Summarize the recon notes";
    mockUploadedFiles = [attachment];
    mockAwaitsAdmission = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("keeps the submitted text and attachments when the gate refuses the Ask", async () => {
    const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
    const sendAdmittedMessage = jest.fn(async () => {
      throw new Error("Continue with Agent to keep going.");
    });
    const { result } = renderHandlers(sendAdmittedMessage);

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await submit(result.current);
    });

    expect(accepted).toBe(false);
    expect(sendAdmittedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Summarize the recon notes",
        files: [expect.objectContaining({ fileId: "file-1" })],
      }),
      expect.objectContaining({
        body: expect.objectContaining({ mode: "ask" }),
      }),
      "ask",
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith(
      "Continue with Agent to keep going.",
    );
    errorToast.mockRestore();
  });

  it("clears the draft once the Ask is admitted, without waiting for the reply", async () => {
    let admit!: () => void;
    const sendAdmittedMessage = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
    );
    const { result } = renderHandlers(sendAdmittedMessage);

    let submission!: Promise<boolean>;
    await act(async () => {
      submission = submit(result.current);
    });
    expect(mockClearInput).not.toHaveBeenCalled();

    await act(async () => {
      admit();
      expect(await submission).toBe(true);
    });
    expect(mockClearInput).toHaveBeenCalledTimes(1);
    expect(mockClearUploadedFiles).toHaveBeenCalledTimes(1);
  });

  it.each(["a newer draft", "another chat"])(
    "does not clear %s typed while admission is pending",
    async (change) => {
      let admit!: () => void;
      const sendAdmittedMessage = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            admit = resolve;
          }),
      );
      const { result, rerender } = renderHandlers(sendAdmittedMessage);

      let submission!: Promise<boolean>;
      await act(async () => {
        submission = submit(result.current);
      });
      if (change === "a newer draft") mockInput = "A different question";
      else rerender({ id: "chat-2" });

      await act(async () => {
        admit();
        await submission;
      });
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    },
  );

  // A known control/null snapshot can be stale (the flag may turn on
  // mid-session), so it never decides whether a free Ask draft is retired.
  it("keeps a free Ask draft until admission even when the status snapshot says no gate", async () => {
    mockAwaitsAdmission = false;
    const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
    const refused = jest.fn(async () => {
      throw new Error("Continue with Agent to keep going.");
    });
    const refusedHandlers = renderHandlers(refused);

    await act(async () => {
      expect(await submit(refusedHandlers.result.current)).toBe(false);
    });
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Summarize the recon notes" }),
      expect.anything(),
      "ask",
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockClearInput).not.toHaveBeenCalled();
    expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    errorToast.mockRestore();

    const admitted = jest.fn(async () => undefined);
    const { result } = renderHandlers(admitted);
    await act(async () => {
      expect(await submit(result.current)).toBe(true);
    });
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockClearInput).toHaveBeenCalledTimes(1);
  });
});

describe.each([true, false])(
  "useChatHandlers Send now for a queued free Ask (snapshot awaits admission: %s)",
  (awaitsAdmission) => {
    const queuedFile = {
      url: "https://files.test/scope.txt",
      mediaType: "text/plain",
      filename: "scope.txt",
      fileId: "file-1",
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockAwaitsAdmission = awaitsAdmission;
      mockMessageQueue.splice(0, mockMessageQueue.length, {
        id: "queued-1",
        text: "Continue the scan",
        files: [queuedFile],
        timestamp: 1,
      });
    });

    afterAll(() => {
      mockMessageQueue.splice(0, mockMessageQueue.length);
    });

    it("keeps the queued text and files when the gate refuses it", async () => {
      const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
      const sendAdmittedMessage = jest.fn(async () => {
        throw new Error("Continue with Agent to keep going.");
      });
      const stopped = { current: false };
      const { result } = renderHandlers(sendAdmittedMessage, "chat-1", stopped);

      await act(async () => {
        await result.current.handleSendNow("queued-1");
      });

      expect(sendAdmittedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Continue the scan",
          files: [queuedFile],
        }),
        expect.objectContaining({
          body: expect.objectContaining({ mode: "ask" }),
          onAdmitted: expect.any(Function),
        }),
        "ask",
      );
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(stopped.current).toBe(true);
      expect(errorToast).toHaveBeenCalledWith(
        "Continue with Agent to keep going.",
      );
      errorToast.mockRestore();
    });

    it("retires the queued item only when the Ask is admitted", async () => {
      let admit!: () => void;
      const sendAdmittedMessage = jest.fn(
        (_message: unknown, options?: unknown) =>
          new Promise<void>((resolve) => {
            admit = () => {
              (options as { onAdmitted: () => void }).onAdmitted();
              resolve();
            };
          }),
      );
      const stopped = { current: false };
      const { result } = renderHandlers(sendAdmittedMessage, "chat-1", stopped);

      let sending!: Promise<void>;
      await act(async () => {
        sending = result.current.handleSendNow("queued-1");
      });
      expect(mockRemoveQueuedMessage).not.toHaveBeenCalled();

      await act(async () => {
        admit();
        await sending;
      });
      expect(mockRemoveQueuedMessage).toHaveBeenCalledTimes(1);
      expect(mockRemoveQueuedMessage).toHaveBeenCalledWith("queued-1");
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(stopped.current).toBe(false);
    });

    it("releases a pending activation queue fence on Send now", async () => {
      const onExplicitSend = jest.fn();
      const stopped = { current: true };
      const { result } = renderHandlers(
        jest.fn(async () => undefined),
        "chat-1",
        stopped,
        onExplicitSend,
      );

      await act(async () => {
        await result.current.handleSendNow("queued-1");
      });

      expect(onExplicitSend).toHaveBeenCalledTimes(1);
    });
  },
);

describe("useChatHandlers free Ask regeneration under the activation gate", () => {
  const savedTranscript = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Explain SSRF" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Saved answer" }],
    },
  ] as ChatMessage[];

  type RegenerateAdmitted = (options: {
    body: Record<string, unknown> & { agentRunRequestId: string };
    onAdmitted?: () => void;
  }) => Promise<"admitted" | "refused" | "settled">;

  // A live transcript so functional updates are applied like React would.
  let transcript: ChatMessage[];
  const sdkRemovesLastAssistant = () => {
    if (transcript.at(-1)?.role === "assistant")
      transcript = transcript.slice(0, -1);
  };
  const newUserMessage = {
    id: "user-new",
    role: "user",
    parts: [{ type: "text", text: "A newer question" }],
  } as ChatMessage;
  const newAssistant = {
    id: "assistant-new",
    role: "assistant",
    parts: [{ type: "text", text: "New streamed answer" }],
  } as ChatMessage;

  const renderRegeneration = (
    regenerateAdmitted: RegenerateAdmitted,
    {
      persisted = true,
      chatId = "chat-1",
      messages = savedTranscript,
    }: { persisted?: boolean; chatId?: string; messages?: ChatMessage[] } = {},
  ) => {
    transcript = messages;
    const setMessages = jest.fn(
      (update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
        transcript = typeof update === "function" ? update(transcript) : update;
      },
    );
    const regenerate = jest.fn(async () => undefined);
    const hook = renderHook(
      ({ id }) =>
        useChatHandlers({
          chatId: id,
          messages,
          sendMessage: mockSendMessage,
          regenerateAdmitted,
          stop: jest.fn(),
          regenerate,
          setMessages,
          isExistingChat: true,
          isUserMessagePersisted: async () => persisted,
          status: "ready",
          isSendingNowRef: { current: false },
          hasManuallyStoppedRef: { current: false },
        }),
      { initialProps: { id: chatId } },
    );
    return { ...hook, setMessages, regenerate };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAwaitsAdmission = true;
  });

  it.each(["handleRegenerate", "handleRetry"] as const)(
    "%s changes nothing before admission and restores the saved answer on a gate refusal",
    async (handler) => {
      const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
      let setMessagesBeforeRequest = -1;
      const regenerateAdmitted = jest.fn<RegenerateAdmitted>(async () => {
        // While the request is pending, nothing local has been cleaned up.
        setMessagesBeforeRequest = setMessages.mock.calls.length;
        expect(mockSetTodos).not.toHaveBeenCalled();
        sdkRemovesLastAssistant();
        throw new Error("Continue with Agent to keep going.");
      });
      const { result, setMessages, regenerate } =
        renderRegeneration(regenerateAdmitted);

      await act(async () => {
        await result.current[handler]();
      });

      expect(setMessagesBeforeRequest).toBe(0);
      // No client deletion, no ordinary regenerate: nothing destructive ran.
      expect(mockMutation).not.toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
      expect(regenerateAdmitted).toHaveBeenCalledWith({
        body: expect.objectContaining({
          regenerate: true,
          deferredRegenerateAssistantIds: ["assistant-1"],
          agentRunRequestId: expect.any(String),
        }),
        onAdmitted: expect.any(Function),
      });
      // Only the SDK's optimistic removal is undone; todos were never touched.
      expect(transcript).toEqual(savedTranscript);
      expect(mockSetTodos).not.toHaveBeenCalled();
      expect(errorToast).toHaveBeenCalledWith(
        "Continue with Agent to keep going.",
      );
      errorToast.mockRestore();
    },
  );

  it("restores the saved answer after a definite non-gate refusal", async () => {
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(async () => {
      sdkRemovesLastAssistant();
      return "refused";
    });
    const { result } = renderRegeneration(regenerateAdmitted);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(transcript).toEqual(savedTranscript);
  });

  it("leaves an uncertain outcome to the existing in-thread handling", async () => {
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(async () => {
      sdkRemovesLastAssistant();
      return "settled";
    });
    const { result } = renderRegeneration(regenerateAdmitted);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(transcript).toEqual([savedTranscript[0]]);
  });

  it("never overwrites a newer message when the gate refuses", async () => {
    const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(async () => {
      sdkRemovesLastAssistant();
      transcript = [...transcript, newUserMessage];
      throw new Error("Continue with Agent to keep going.");
    });
    const { result } = renderRegeneration(regenerateAdmitted);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(transcript).toEqual([savedTranscript[0], newUserMessage]);
    errorToast.mockRestore();
  });

  it("never overwrites a same-ID revision of text or attachments when the gate refuses", async () => {
    const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
    const revisedUser = {
      ...savedTranscript[0],
      parts: [
        { type: "text", text: "Explain blind SSRF instead" },
        {
          type: "file",
          mediaType: "text/plain",
          filename: "scope.txt",
          url: "",
          fileId: "file-2",
        },
      ],
    } as ChatMessage;
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(async () => {
      sdkRemovesLastAssistant();
      // Same IDs as the expected post-removal state, different content.
      transcript = [revisedUser];
      throw new Error("Continue with Agent to keep going.");
    });
    const { result } = renderRegeneration(regenerateAdmitted);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(transcript).toEqual([revisedUser]);
    errorToast.mockRestore();
  });

  it("cleans up at admission by exact old IDs, keeping the new streamed answer", async () => {
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(
      async ({ onAdmitted }) => {
        sdkRemovesLastAssistant();
        // Even a reply that is already visible must survive the cleanup.
        transcript = [...transcript, newAssistant];
        expect(mockSetTodos).not.toHaveBeenCalled();
        onAdmitted?.();
        return "admitted";
      },
    );
    const { result } = renderRegeneration(regenerateAdmitted, {
      messages: [
        ...savedTranscript,
        {
          id: "continue-1",
          role: "user",
          metadata: { isAutoContinue: true },
          parts: [{ type: "text", text: "continue" }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Saved continuation" }],
        },
      ] as ChatMessage[],
    });

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(mockMutation).not.toHaveBeenCalled();
    expect(transcript).toEqual([savedTranscript[0], newAssistant]);
    // Todos from the old chain are removed only at admission.
    expect(mockSetTodos).toHaveBeenCalledTimes(1);
    expect(mockSetTodos).toHaveBeenCalledWith([]);
  });

  it("does not clean up or restore a chat the user has left", async () => {
    let settle!: (outcome: "admitted") => void;
    let admit: (() => void) | undefined;
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(
      ({ onAdmitted }) =>
        new Promise((resolve) => {
          admit = onAdmitted;
          settle = resolve;
        }),
    );
    const { result, rerender, setMessages } =
      renderRegeneration(regenerateAdmitted);

    let regenerating!: Promise<void>;
    await act(async () => {
      regenerating = result.current.handleRegenerate();
    });
    rerender({ id: "chat-2" });
    await act(async () => {
      admit?.();
      settle("admitted");
      await regenerating;
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(mockSetTodos).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("keeps saved progress after an unconfirmed request instead of retrying", async () => {
    const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(
      async () => "admitted",
    );
    const { result, setMessages, regenerate } = renderRegeneration(
      regenerateAdmitted,
      { persisted: false },
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(regenerateAdmitted).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith(
      "Could not retry yet. Your saved answer is unchanged.",
      expect.anything(),
    );
    errorToast.mockRestore();
  });

  it("keeps the existing client deletion when the status is known not to gate", async () => {
    mockAwaitsAdmission = false;
    const regenerateAdmitted = jest.fn<RegenerateAdmitted>(
      async () => "admitted",
    );
    const { result, regenerate } = renderRegeneration(regenerateAdmitted);

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(regenerateAdmitted).not.toHaveBeenCalled();
    expect(mockMutation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", resetSummary: true }),
    );
    expect(regenerate).toHaveBeenCalledWith({
      body: expect.not.objectContaining({
        deferredRegenerateAssistantIds: expect.anything(),
      }),
    });
  });

  it.each(["handleRegenerate", "handleRetry"] as const)(
    "%s refuses a chain beyond the deferred bound without touching anything",
    async (handler) => {
      const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
      const longChain = [
        savedTranscript[0],
        ...Array.from({ length: 257 }, (_, index) => ({
          id: `assistant-${index}`,
          role: "assistant",
          parts: [{ type: "text", text: `Part ${index}` }],
        })),
      ] as ChatMessage[];
      const regenerateAdmitted = jest.fn<RegenerateAdmitted>(
        async () => "admitted",
      );
      const { result, setMessages, regenerate } = renderRegeneration(
        regenerateAdmitted,
        { messages: longChain },
      );

      await act(async () => {
        await result.current[handler]();
      });

      expect(mockMutation).not.toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
      expect(regenerateAdmitted).not.toHaveBeenCalled();
      expect(setMessages).not.toHaveBeenCalled();
      expect(mockSetTodos).not.toHaveBeenCalled();
      expect(errorToast).toHaveBeenCalledWith(
        "This answer is too long to rerun. It is unchanged.",
        expect.objectContaining({
          description: "Send a new message to continue.",
        }),
      );
      errorToast.mockRestore();
    },
  );
});

describe("useChatHandlers free Ask history edits under the activation gate", () => {
  const transcript = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Explain SSRF" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Saved answer" }],
    },
  ] as ChatMessage[];

  const renderEdit = () => {
    const setMessages = jest.fn();
    const regenerate = jest.fn(async () => undefined);
    const stop = jest.fn();
    const hook = renderHook(() =>
      useChatHandlers({
        chatId: "chat-1",
        messages: transcript,
        sendMessage: mockSendMessage,
        stop,
        regenerate,
        setMessages,
        isExistingChat: true,
        status: "ready",
        isSendingNowRef: { current: false },
        hasManuallyStoppedRef: { current: false },
      }),
    );
    return { ...hook, setMessages, regenerate, stop };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAwaitsAdmission = true;
  });

  it("refuses the edit before stopping, mutating or streaming anything", async () => {
    const { result, setMessages, regenerate, stop } = renderEdit();

    await act(async () => {
      await expect(
        result.current.handleEditMessage("user-1", "Revised question", [
          "file-1",
        ]),
      ).rejects.toMatchObject({
        name: "FreeAskEditBlockedError",
        message:
          "Send this revision as a new message to keep your saved answer.",
      });
    });

    expect(mockMutation).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(mockSetTodos).not.toHaveBeenCalled();
    // The composer draft is never overwritten with the revision.
    expect(mockClearInput).not.toHaveBeenCalled();
  });

  it("keeps the existing edit when the status is known not to gate", async () => {
    mockAwaitsAdmission = false;
    const { result, regenerate } = renderEdit();

    await act(async () => {
      await result.current.handleEditMessage("user-1", "Revised question");
    });

    expect(mockMutation).toHaveBeenCalled();
    expect(regenerate).toHaveBeenCalledWith({
      body: expect.objectContaining({ regenerate: true }),
    });
  });
});
