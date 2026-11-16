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

jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(async () => null),
}));

const mockSendMessage = jest.fn(async () => undefined);
const mockClearInput = jest.fn();
const mockClearUploadedFiles = jest.fn();
let mockInput = "";
let mockUploadedFiles: unknown[] = [];
// GlobalState sets this for the test variant and for an unknown status.
let mockAwaitsAdmission = true;

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    getInput: () => mockInput,
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: "ask",
    clearInput: mockClearInput,
    clearUploadedFiles: mockClearUploadedFiles,
    todos: [],
    setTodos: jest.fn(),
    isUploadingFiles: false,
    subscription: "free",
    queueMessage: jest.fn(),
    messageQueue: [],
    removeQueuedMessage: jest.fn(),
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
        hasManuallyStoppedRef: { current: false },
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

  it("keeps the immediate Ask send when the status is known not to gate", async () => {
    mockAwaitsAdmission = false;
    const sendAdmittedMessage = jest.fn(async () => undefined);
    const { result } = renderHandlers(sendAdmittedMessage);

    await act(async () => {
      expect(await submit(result.current)).toBe(true);
    });

    expect(sendAdmittedMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockClearInput).toHaveBeenCalledTimes(1);
  });
});
