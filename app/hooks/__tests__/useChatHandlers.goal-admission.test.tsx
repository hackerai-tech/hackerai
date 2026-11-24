import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { toast } from "sonner";
import { CloudWorkspaceSelectionRequiredError } from "@/lib/ai/tools/utils/cloud-workspace-selection-error";
import { ChatSDKError } from "@/lib/errors";

// Real useChatHandlers with its stateful collaborators replaced at their
// boundary: the composer store, Convex mutations and the goal sender.
jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => "test-user",
  captureQueuedAuthenticatedEvent: jest.fn(),
  captureAuthenticatedEvent: jest.fn(),
}));

jest.mock("@/app/services/desktop-command-cancellation", () => ({
  cancelDesktopRunLocally: jest.fn(async () => undefined),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    chatStreams: { cancelStreamFromClient: "cancelStreamFromClient" },
    agentSteers: { create: "createAgentSteer" },
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

const mockClearInput = jest.fn();
const mockClearUploadedFiles = jest.fn();
let mockInput = "";
let mockUploadedFiles: unknown[] = [];

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    getInput: () => mockInput,
    uploadedFiles: mockUploadedFiles,
    getUploadedFiles: () => mockUploadedFiles,
    chatMode: "agent",
    clearInput: mockClearInput,
    clearUploadedFiles: mockClearUploadedFiles,
    todos: [],
    setTodos: jest.fn(),
    isUploadingFiles: false,
    subscription: "pro",
    queueMessage: jest.fn(),
    messageQueue: [],
    removeQueuedMessage: jest.fn(),
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

const scopeFile = {
  file: new File(["in scope"], "scope-lab.txt", { type: "text/plain" }),
  uploaded: true,
  uploading: false,
  storage: "s3",
  fileId: "scope-file",
};

const renderHandlers = (
  sendGoalMessage: (message: any, options?: { body?: any }) => Promise<void>,
  isExistingChat = false,
) =>
  renderHook(() =>
    useChatHandlers({
      chatId: "goal-chat",
      messages: [],
      sendMessage: jest.fn(async () => undefined),
      sendGoalMessage,
      stop: jest.fn(),
      regenerate: jest.fn(),
      setMessages: jest.fn(),
      isExistingChat,
      status: "ready",
      isSendingNowRef: { current: false },
      hasManuallyStoppedRef: { current: false },
    }),
  );

describe("useChatHandlers goal admission refusals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInput = "/goal start Map the lab app";
    mockUploadedFiles = [scopeFile];
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("hands a /goal start workspace selection refusal to the composer with the draft and files intact", async () => {
    const toastError = jest.spyOn(toast, "error").mockReturnValue(0);
    const refusal = new CloudWorkspaceSelectionRequiredError();
    const sendGoalMessage = jest.fn(async () => {
      throw refusal;
    });
    try {
      const { result } = renderHandlers(sendGoalMessage);
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current
          .handleSubmit({ preventDefault: jest.fn() } as any)
          .catch((error: unknown) => error);
      });
      // The typed refusal (with its metadata) reaches the composer.
      expect(outcome).toBe(refusal);
      expect(sendGoalMessage).toHaveBeenCalledTimes(1);
      expect(sendGoalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Map the lab app",
          files: [expect.objectContaining({ fileId: "scope-file" })],
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            goal: expect.objectContaining({ action: "start" }),
          }),
        }),
      );
      expect(toastError).not.toHaveBeenCalled();
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    } finally {
      toastError.mockRestore();
    }
  });

  it("keeps other refused goal starts on the existing toast path", async () => {
    const toastError = jest.spyOn(toast, "error").mockReturnValue(0);
    const sendGoalMessage = jest.fn(async () => {
      throw new ChatSDKError("bad_request:chat", "Goal limit reached.");
    });
    try {
      const { result } = renderHandlers(sendGoalMessage);
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(mockClearInput).not.toHaveBeenCalled();
      expect(mockClearUploadedFiles).not.toHaveBeenCalled();
    } finally {
      toastError.mockRestore();
    }
  });

  it("keeps a workspace refusal for /goal resume on the existing toast path", async () => {
    // Recovery UI is scoped to initial starts; resume keeps today's behavior.
    mockInput = "/goal resume";
    mockUploadedFiles = [];
    const toastError = jest.spyOn(toast, "error").mockReturnValue(0);
    const fetchMock = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            enabled: true,
            goal: {
              generation: 4,
              objective: "Map the lab app",
              state: "paused",
              sandboxPreference: "e2b",
              permissionMode: "full_access",
              selectedModel: "hackerai-standard",
            },
          }),
        }) as Response,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    const sendGoalMessage = jest.fn(async () => {
      throw new CloudWorkspaceSelectionRequiredError();
    });
    try {
      const { result } = renderHandlers(sendGoalMessage, true);
      await act(async () => {
        expect(
          await result.current.handleSubmit({
            preventDefault: jest.fn(),
          } as any),
        ).toBe(false);
      });
      expect(sendGoalMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            goal: expect.objectContaining({ action: "resume" }),
          }),
        }),
      );
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("Choose which existing Cloud workspace"),
      );
      expect(mockClearInput).not.toHaveBeenCalled();
    } finally {
      toastError.mockRestore();
    }
  });
});
