import "@testing-library/jest-dom";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { getFunctionName } from "convex/server";
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReactNode, StrictMode, useEffect, useState } from "react";
import {
  CHAT_MODE_STORAGE_KEY,
  CONVERSATION_DRAFTS_STORAGE_KEY,
  getDraftAttachmentsById,
  getDraftContentById,
  upsertDraft,
} from "@/lib/utils/client-storage";
import type { UploadedFileState } from "@/types/file";
import { useComposerActions } from "@/app/contexts/ComposerState";
import { toast } from "sonner";
import { GoalSubmissionUnconfirmedError } from "@/lib/chat/goal-submission";
const mockGoalCapture = jest.fn<
  (event: string, properties: Record<string, unknown>) => boolean
>(() => true);

jest.mock("@/lib/analytics/client", () => ({
  ...jest.requireActual<typeof import("@/lib/analytics/client")>(
    "@/lib/analytics/client",
  ),
  captureAuthenticatedEvent: (
    event: string,
    properties: Record<string, unknown>,
  ) => mockGoalCapture(event, properties),
}));

let mockIsMobile = false;
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

let mockSandboxState: Partial<
  ReturnType<typeof import("@/app/contexts/GlobalState").useGlobalState>
> = {};
jest.mock("@/app/contexts/GlobalState", () => {
  const original = jest.requireActual<
    typeof import("@/app/contexts/GlobalState")
  >("@/app/contexts/GlobalState");
  return {
    ...original,
    useGlobalState: () => ({
      ...original.useGlobalState(),
      ...mockSandboxState,
    }),
  };
});

const mockUseQuery = jest.fn(() => undefined);
const mockReadGeneratedTextAttachment = jest.fn();
const mockHandleRemoveFile = jest.fn();
const mockFetch = jest.fn();

const setNavigatorOnline = (isOnline: boolean) => {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: isOnline,
  });
};

// Keep real providers; stub external services and sandbox lifecycle snapshots.
jest.mock("react-hotkeys-hook", () => ({
  useHotkeys: jest.fn(),
}));

// Mock Convex hooks used by useFileUpload
jest.mock("convex/react", () => ({
  useAuth: () => ({ user: null, entitlements: [] }),
  useMutation: () => jest.fn(),
  useAction: () => jest.fn(),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/app/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileInputRef: { current: null },
    handleFileUploadEvent: jest.fn(),
    handleRemoveFile: mockHandleRemoveFile,
    handleUpdateGeneratedTextFile: jest.fn(),
    handleAttachClick: jest.fn(),
    handlePasteEvent: jest.fn(),
    handlePastedTextAttachment: jest.fn(),
  }),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  useTauri: () => ({ isTauri: false }),
  isTauriEnvironment: jest.fn(() => false),
  readGeneratedTextAttachment: (...args: unknown[]) =>
    mockReadGeneratedTextAttachment(...args),
}));

const { isTauriEnvironment } = jest.requireMock<
  typeof import("@/app/hooks/useTauri")
>("@/app/hooks/useTauri");

const { ChatInput } =
  jest.requireActual<typeof import("../ChatInput")>("../ChatInput");
const { GlobalStateProvider, useGlobalState } = jest.requireActual<
  typeof import("../../contexts/GlobalState")
>("../../contexts/GlobalState");
const { AgentApprovalProvider, useAgentApproval } = jest.requireActual<
  typeof import("../../contexts/AgentApprovalContext")
>("../../contexts/AgentApprovalContext");
const { AgentAutoReviewAvailabilityProvider } = jest.requireActual<
  typeof import("../../contexts/AgentAutoReviewAvailabilityContext")
>("../../contexts/AgentAutoReviewAvailabilityContext");

// Wrapper with real providers
const TestWrapper = ({ children }: { children: ReactNode }) => {
  return (
    <GlobalStateProvider>
      <AgentAutoReviewAvailabilityProvider>
        <AgentApprovalProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </AgentApprovalProvider>
      </AgentAutoReviewAvailabilityProvider>
    </GlobalStateProvider>
  );
};

const UploadedFilesSetter = ({
  files,
  label,
}: {
  files: UploadedFileState[];
  label: string;
}) => {
  const { setUploadedFiles } = useGlobalState();

  return (
    <button type="button" onClick={() => setUploadedFiles(files)}>
      {label}
    </button>
  );
};

const NewChatAttachmentSubmitHarness = ({
  uploadedFile,
}: {
  uploadedFile: UploadedFileState;
}) => {
  const { setUploadedFiles } = useGlobalState();
  const [hasMessages, setHasMessages] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setUploadedFiles([uploadedFile])}>
        Attach file
      </button>
      <ChatInput
        onSubmit={() => {
          setHasMessages(true);
          setUploadedFiles([]);
          return true;
        }}
        onStop={jest.fn()}
        status="ready"
        isNewChat={true}
        hasMessages={hasMessages}
        chatId="chat-1"
      />
    </>
  );
};

const StableAttachmentSubmitHarness = () => {
  const { clearUploadedFiles } = useGlobalState();
  const { clearInput } = useComposerActions();
  return (
    <ChatInput
      onSubmit={async () => {
        await Promise.resolve();
        clearInput();
        clearUploadedFiles();
        return true;
      }}
      onStop={jest.fn()}
      status="streaming"
      chatId="stable-attachment"
    />
  );
};

const AgentApprovalSetter = () => {
  const { setChatMode } = useGlobalState();
  const { setAgentApprovalSession, setActiveToolApprovalRequest } =
    useAgentApproval();

  useEffect(() => {
    setChatMode("agent");
    setAgentApprovalSession({
      chatId: "approval-chat",
      sessionId: "agent-approval-session",
      publicAccessToken: "public-token",
    });
    setActiveToolApprovalRequest({
      approvalId: "approval-1",
      toolCallId: "tool-1",
      title: "Allow HackerAI to run this terminal command?",
      target: "ping -c 4 hackerone.com",
      justification: "Check whether the target host is reachable.",
      prefixRule: ["ping", "-c", "4"],
      detail: "Approve to continue, or deny to stop this command.",
      kind: "terminal",
      operation: "terminal_execute",
    });
  }, [setActiveToolApprovalRequest, setAgentApprovalSession, setChatMode]);

  return null;
};

const SelectedComputerProbe = () => {
  const { sandboxPreference, chatMode } = useGlobalState();
  return (
    <output data-testid="selected-computer">
      {chatMode}:{sandboxPreference}
    </output>
  );
};

const AgentModeSetter = () => {
  const { setChatMode } = useGlobalState();

  useEffect(() => {
    setChatMode("agent");
  }, [setChatMode]);

  return null;
};

const TaskPanelsSetter = () => {
  const { setTodos, queueMessage } = useGlobalState();

  useEffect(() => {
    setTodos([
      { id: "todo-1", content: "Private task progress", status: "in_progress" },
    ]);
    queueMessage("Private queued message");
  }, [setTodos, queueMessage]);

  return null;
};

describe("ChatInput - Integration Tests", () => {
  const mockOnSubmit = jest.fn();
  const mockOnStop = jest.fn();
  const mockOnReconnect = jest.fn();

  beforeEach(() => {
    mockIsMobile = false;
    jest.clearAllMocks();
    mockSandboxState = {};
    jest.mocked(isTauriEnvironment).mockReturnValue(false);
    jest
      .mocked(useAuth)
      .mockReturnValue({ user: null, entitlements: [] } as ReturnType<
        typeof useAuth
      >);
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue(undefined);
    mockReadGeneratedTextAttachment.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ assignment: null }),
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: mockFetch,
    });
    window.localStorage.clear();
    setNavigatorOnline(true);
  });

  describe("Keyboard and draft edge cases", () => {
    it.each(["insertText", "deleteContentBackward"])(
      "preserves a burst of native %s edits without exceeding React's update depth",
      async (inputType) => {
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              chatId="burst-draft"
            />
          </TestWrapper>,
        );
        const input = (await screen.findByRole(
          "textbox",
        )) as HTMLTextAreaElement;
        const nativeSetValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => {
          errors.push(event.error);
          event.preventDefault();
        };
        // Real input events flush each controlled edit. Wrapping the burst in
        // act() batches them together and conceals the production regression.
        const environment = globalThis as typeof globalThis & {
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        };
        const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
        window.addEventListener("error", onError);
        environment.IS_REACT_ACT_ENVIRONMENT = false;
        let value = "";
        try {
          for (let index = 0; index < 120; index++) {
            value = "x".repeat(
              inputType === "insertText" ? index + 1 : 240 - index,
            );
            nativeSetValue.call(input, value);
            input.dispatchEvent(
              new InputEvent("input", { bubbles: true, inputType }),
            );
          }
        } finally {
          environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
          window.removeEventListener("error", onError);
        }
        expect(errors).toEqual([]);
        expect(input).toHaveValue(value);
        expect(getDraftContentById("burst-draft")).toBe(value);
        expect(mockOnSubmit).not.toHaveBeenCalled();
      },
    );

    it("restores a saved draft through StrictMode mount effects", async () => {
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "saved-draft",
              content: "Previously saved draft",
              timestamp: Date.now(),
            },
          ],
        }),
      );
      render(
        <StrictMode>
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              chatId="saved-draft"
            />
          </TestWrapper>
        </StrictMode>,
      );
      expect(await screen.findByTestId("chat-input")).toHaveValue(
        "Previously saved draft",
      );
      expect(getDraftContentById("saved-draft")).toBe("Previously saved draft");
    });

    it.each([{ isComposing: true }, { keyCode: 229 }])(
      "does not submit Enter while an IME candidate is being confirmed: %j",
      async (compositionEvent) => {
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              chatId="ime-chat"
            />
          </TestWrapper>,
        );
        const input = await screen.findByTestId("chat-input");
        fireEvent.change(input, { target: { value: "日本語の下書き" } });
        fireEvent.keyDown(input, { key: "Enter", ...compositionEvent });
        await act(async () => {});
        expect(mockOnSubmit).not.toHaveBeenCalled();
        expect(input).toHaveValue("日本語の下書き");
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
      },
    );

    it.each(["unmount", "pagehide"])(
      "keeps the latest draft when %s happens before the autosave delay",
      async (boundary) => {
        const { unmount } = render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              chatId="fast-draft"
            />
          </TestWrapper>,
        );
        const input = await screen.findByTestId("chat-input");
        fireEvent.change(input, {
          target: { value: "Last characters before leaving" },
        });
        if (boundary === "unmount") unmount();
        else fireEvent(window, new Event("pagehide"));
        expect(getDraftContentById("fast-draft")).toBe(
          "Last characters before leaving",
        );
      },
    );

    it("keeps an unsaved queued edit mounted when a free user's Agent becomes ready", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = { subscription: "free", isCheckingProPlan: false };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ assignment: { variant: "test", country: "IN" } }),
      });
      const view = (status: "streaming" | "ready") => (
        <TestWrapper>
          <AgentModeSetter />
          <TaskPanelsSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            status={status}
            hasMessages
            chatId="queued-edit"
          />
        </TestWrapper>
      );
      const { rerender } = render(view("streaming"));
      const options = await screen.findByRole("button", {
        name: "More options for queued message: Private queued message",
      });
      fireEvent.keyDown(options, { key: "Enter" });
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Edit message" }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Edit queued message" }),
        { target: { value: "Unsaved revised message" } },
      );
      rerender(view("ready"));
      await act(async () => {});
      expect(
        screen.getByRole("textbox", { name: "Edit queued message" }),
      ).toHaveValue("Unsaved revised message");
      expect(
        screen.queryByTestId("regional-subscription-offer"),
      ).not.toBeInTheDocument();
      fireEvent.change(screen.getByTestId("chat-input"), {
        target: { value: "A new request while editing" },
      });
      fireEvent.keyDown(screen.getByTestId("chat-input"), { key: "Enter" });
      await act(async () => {});
      expect(mockOnSubmit).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "Save", exact: true }),
      );
      expect(
        await screen.findByTestId("regional-subscription-offer"),
      ).toBeVisible();
    });
  });

  describe("Sandbox disconnect warnings", () => {
    afterEach(() => jest.restoreAllMocks());
    const ui = () => (
      <TestWrapper>
        <ChatInput onSubmit={mockOnSubmit} onStop={mockOnStop} status="ready" />
      </TestWrapper>
    );

    beforeEach(() => {
      jest.spyOn(toast, "info").mockReturnValue(0);
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = {
        chatMode: "agent",
        subscription: "free",
        isCheckingProPlan: false,
        freeDesktopAgentOnlyActive: true,
        sandboxPreference: "desktop",
        desktopBridgeStatus: "connected",
        localConnections: [],
        hasLocalSandbox: true,
      };
    });

    it("does not mistake task selection changes for a disconnect", async () => {
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      for (const sandboxPreference of [
        "e2b",
        "desktop",
        "missing-runner",
        "desktop",
      ]) {
        mockSandboxState = { ...mockSandboxState, sandboxPreference };
        rerender(ui());
      }
      expect(toast.info).not.toHaveBeenCalled();
    });

    it("waits for Desktop startup without flashing a disconnect warning and preserves the draft", async () => {
      jest.mocked(isTauriEnvironment).mockReturnValue(true);
      mockSandboxState = {
        ...mockSandboxState,
        desktopBridgeStatus: "idle",
        hasLocalSandbox: false,
      };
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      const textarea = await screen.findByRole("textbox");
      fireEvent.change(textarea, { target: { value: "Test startup" } });

      for (const desktopBridgeStatus of ["idle", "connecting"] as const) {
        mockSandboxState = { ...mockSandboxState, desktopBridgeStatus };
        rerender(ui());
        expect(
          screen.queryByText("Your computer is disconnected."),
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
        fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
        expect(mockOnSubmit).not.toHaveBeenCalled();
        expect(textarea).toHaveValue("Test startup");
      }

      mockSandboxState = {
        ...mockSandboxState,
        desktopBridgeStatus: "connected",
        hasLocalSandbox: true,
      };
      rerender(ui());
      expect(
        screen.queryByText("Your computer is disconnected."),
      ).not.toBeInTheDocument();
      expect(toast.info).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
    });

    it("shows reconnect controls if Desktop startup fails", async () => {
      jest.mocked(isTauriEnvironment).mockReturnValue(true);
      const retryDesktopBridge = jest.fn();
      mockSandboxState = {
        ...mockSandboxState,
        desktopBridgeStatus: "connecting",
        hasLocalSandbox: false,
        retryDesktopBridge,
      };
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      expect(
        screen.queryByText("Your computer is disconnected."),
      ).not.toBeInTheDocument();

      mockSandboxState = { ...mockSandboxState, desktopBridgeStatus: "failed" };
      rerender(ui());
      expect(
        screen.getByText("Your computer is disconnected."),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      expect(retryDesktopBridge).toHaveBeenCalledTimes(1);
    });

    it("does not warn when free Desktop access finishes resolving", async () => {
      mockSandboxState = {
        ...mockSandboxState,
        isCheckingProPlan: true,
        freeDesktopAgentOnlyActive: false,
        sandboxPreference: "e2b",
      };
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      mockSandboxState = {
        ...mockSandboxState,
        isCheckingProPlan: false,
        freeDesktopAgentOnlyActive: true,
      };
      rerender(ui());
      mockSandboxState = { ...mockSandboxState, sandboxPreference: "desktop" };
      rerender(ui());
      expect(toast.info).not.toHaveBeenCalled();
    });

    it("warns once when the selected Desktop bridge actually disconnects", async () => {
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      mockSandboxState = {
        ...mockSandboxState,
        desktopBridgeStatus: "connecting",
      };
      rerender(ui());
      rerender(ui());
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith(
        "Desktop sandbox disconnected.",
        expect.objectContaining({
          description: "Reconnect the Desktop sandbox to keep using Agent.",
        }),
      );
    });

    it("warns when the selected remote runner disconnects even if Desktop is healthy", async () => {
      mockSandboxState = {
        ...mockSandboxState,
        sandboxPreference: "remote-kali",
        localConnections: [{ connectionId: "remote-kali", isDesktop: false }],
      };
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      mockSandboxState = { ...mockSandboxState, localConnections: [] };
      rerender(ui());
      expect(toast.info).toHaveBeenCalledWith(
        "Local sandbox disconnected.",
        expect.objectContaining({
          description:
            "Reconnect the selected local runner to keep using Agent.",
        }),
      );
    });

    it("still switches free web Agent to Ask when its local connection is lost on the Cloud default", async () => {
      const setChatMode = jest.fn();
      mockSandboxState = {
        ...mockSandboxState,
        freeDesktopAgentOnlyActive: false,
        sandboxPreference: "e2b",
        defaultLocalSandboxPreference: null,
        setChatMode,
      };
      const { rerender } = render(ui());
      await screen.findByRole("textbox");
      mockSandboxState = { ...mockSandboxState, hasLocalSandbox: false };
      rerender(ui());
      expect(setChatMode).toHaveBeenCalledWith("ask");
      expect(toast.info).toHaveBeenCalledWith(
        "Local sandbox disconnected. Switched to Ask mode.",
        expect.any(Object),
      );
    });
  });

  describe("Ask Mode Integration", () => {
    it("leaves the unrestricted file picker accept list unset", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      expect(screen.getByLabelText("Upload files")).not.toHaveAttribute(
        "accept",
      );
    });

    it("renders Ask mode by default without the logged-out mode selector", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      expect(
        screen.getByPlaceholderText("Ask, learn, brainstorm"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Ask")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("attach-files-button").querySelector(".lucide-plus"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("attach-files-button").querySelector(".size-5"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("attach-files-button")).toHaveClass(
        "h-8",
        "w-8",
        "rounded-md",
        "hover:bg-muted/30",
      );
      expect(screen.getByTestId("attach-files-button")).not.toHaveClass(
        "rounded-full",
      );
    });

    it("should show only submit button when ready in ask mode", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      expect(screen.getByLabelText("Send message")).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Stop generation"),
      ).not.toBeInTheDocument();
    });

    it("keeps the draft and attachments while offline, then enables send after reconnect", async () => {
      const uploadedFile: UploadedFileState = {
        file: new File(["evidence"], "evidence.txt", { type: "text/plain" }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_evidence",
      };
      setNavigatorOnline(false);

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Add evidence" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onReconnect={mockOnReconnect}
            status="ready"
            isNewChat
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Add evidence"));
      const input = screen.getByPlaceholderText("Ask, learn, brainstorm");
      fireEvent.change(input, { target: { value: "Preserve this draft" } });

      expect(screen.getByTestId("offline-status")).toHaveTextContent(
        "You're offline",
      );
      expect(screen.getByLabelText("Send message")).toBeDisabled();
      expect(screen.getByText("evidence.txt")).toBeInTheDocument();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(mockOnSubmit).not.toHaveBeenCalled();
      expect(input).toHaveValue("Preserve this draft");
      expect(screen.getByText("evidence.txt")).toBeInTheDocument();

      await waitFor(() => {
        expect(getDraftContentById("new")).toBe("Preserve this draft");
        expect(getDraftAttachmentsById("new")).toHaveLength(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

      await waitFor(() => {
        expect(screen.queryByTestId("offline-status")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Send message")).toBeEnabled();
      });
      expect(mockFetch).toHaveBeenCalledWith("/api/health/connectivity", {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      });
      expect(mockOnReconnect).toHaveBeenCalledTimes(1);
      expect(mockOnSubmit).not.toHaveBeenCalled();
      expect(input).toHaveValue("Preserve this draft");
    });

    it("keeps the draft blocked when reconnect cannot reach HackerAI", async () => {
      setNavigatorOnline(false);
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onReconnect={mockOnReconnect}
            status="ready"
            isNewChat
          />
        </TestWrapper>,
      );

      const input = screen.getByPlaceholderText("Ask, learn, brainstorm");
      fireEvent.change(input, { target: { value: "Keep this safe" } });
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

      await waitFor(() => {
        expect(screen.getByTestId("offline-status")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
      });
      expect(screen.getByLabelText("Send message")).toBeDisabled();
      expect(input).toHaveValue("Keep this safe");
      expect(mockOnReconnect).not.toHaveBeenCalled();
    });

    it("does not show authenticated-chat offline UI when protection is disabled", () => {
      setNavigatorOnline(false);

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            offlineProtection={false}
          />
        </TestWrapper>,
      );

      const input = screen.getByPlaceholderText("Ask, learn, brainstorm");
      fireEvent.change(input, { target: { value: "Start from landing page" } });

      expect(screen.queryByTestId("offline-status")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send message")).toBeEnabled();

      fireEvent.click(screen.getByLabelText("Send message"));
      expect(mockOnSubmit).toHaveBeenCalledTimes(1);
    });

    it("restores an unavailable pasted-text attachment into the Ask field", async () => {
      const pastedContent = "Source material restored from the attachment";
      const uploadedFile: UploadedFileState = {
        file: new File([pastedContent], "Pasted text.txt", {
          type: "text/plain",
        }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_pasted",
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: "paste_123",
          content: pastedContent,
        },
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Attach paste" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Attach paste"));

      expect(await screen.findByText("Unavailable in Ask")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Show in text field"));

      await waitFor(() =>
        expect(
          screen.getByPlaceholderText("Ask, learn, brainstorm"),
        ).toHaveValue(pastedContent),
      );
      expect(mockHandleRemoveFile).toHaveBeenCalledWith(0);
    });

    it("shows only the stop action while Ask is streaming and calls onStop when clicked", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
          />
        </TestWrapper>,
      );

      const stopButton = screen.getByLabelText("Stop generation");
      expect(stopButton).toBeInTheDocument();
      expect(screen.queryByLabelText("Queue message")).not.toBeInTheDocument();
      fireEvent.click(stopButton);

      expect(mockOnStop).toHaveBeenCalledTimes(1);
    });

    it("hides a stale stop action after an Agent run is known to be terminal", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
            hideStop
          />
        </TestWrapper>,
      );

      expect(
        screen.queryByLabelText("Stop generation"),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send message")).toBeDisabled();
    });

    it("should not show queue panel in ask mode even with queued messages", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      // Queue panel should not be visible in ask mode
      expect(screen.queryByText("Queued messages")).not.toBeInTheDocument();
    });

    it("keeps composer Stop available for a persisted goal run while the local stream is ready", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            hasActiveGoalRun
          />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByLabelText("Stop generation"));
      expect(mockOnStop).toHaveBeenCalledTimes(1);
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it.each(["ready", "streaming"] as const)(
      "allows clicking Send beside Stop during an active goal with %s stream status",
      (status) => {
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status={status}
              hasActiveGoalRun
              pauseGoalOnSend
            />
          </TestWrapper>,
        );
        expect(
          screen.queryByLabelText("Send message and pause goal"),
        ).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "Please check the saved result" },
        });
        expect(screen.getByLabelText("Stop generation")).toBeEnabled();
        fireEvent.click(screen.getByLabelText("Send message and pause goal"));
        expect(mockOnSubmit).toHaveBeenCalledTimes(1);
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.any(Object),
          undefined,
        );
        expect(mockOnStop).not.toHaveBeenCalled();
      },
    );

    it.each([true, false])(
      "prevents overlapping goal follow-ups and releases the guard after acceptance=%s",
      async (accepted) => {
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        let settle!: (value: boolean) => void;
        mockOnSubmit.mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
        );
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="streaming"
              hasActiveGoalRun
              pauseGoalOnSend
            />
          </TestWrapper>,
        );
        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "First follow-up" } });
        fireEvent.click(screen.getByLabelText("Send message and pause goal"));
        fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
        fireEvent.click(screen.getByLabelText("Send message and pause goal"));
        expect(mockOnSubmit).toHaveBeenCalledTimes(1);
        expect(
          screen.getByLabelText("Send message and pause goal"),
        ).toBeDisabled();
        expect(screen.getByLabelText("Stop generation")).toBeEnabled();
        await act(async () => settle(accepted));
        if (accepted) {
          await waitFor(() => expect(input).toHaveValue(""));
        } else {
          expect(input).toHaveValue("First follow-up");
        }
        fireEvent.change(input, { target: { value: "Next follow-up" } });
        fireEvent.click(screen.getByLabelText("Send message and pause goal"));
        expect(mockOnSubmit).toHaveBeenCalledTimes(2);
      },
    );

    it("explains that follow-ups pause a waiting goal without mislabeling goal commands", () => {
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            pauseGoalOnSend
          />
        </TestWrapper>,
      );
      const input = screen.getByRole("textbox");
      fireEvent.change(input, {
        target: { value: "Please check the saved result" },
      });
      expect(
        screen.getByLabelText("Send message and pause goal"),
      ).toBeEnabled();
      fireEvent.change(input, { target: { value: "/GOAL status" } });
      expect(screen.getByLabelText("Send message")).toBeEnabled();
      fireEvent.change(input, { target: { value: "/goals are useful" } });
      expect(
        screen.getByLabelText("Send message and pause goal"),
      ).toBeEnabled();
    });
  });

  describe("Signed-out home composer", () => {
    it.each([
      ["desktop", true],
      ["desktop", false],
      ["missing-remote", false],
    ])(
      "hides disconnected %s controls (native=%s) and allows the auth submission with a saved Agent preference",
      async (sandboxPreference, isNative) => {
        jest.mocked(isTauriEnvironment).mockReturnValue(isNative);
        window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
        window.localStorage.setItem("sandbox-preference", sandboxPreference);
        mockUseQuery.mockReturnValue([]);
        render(
          <TestWrapper>
            <ChatInput
              isNewChat
              restoreDraftAttachments={false}
              offlineProtection={false}
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
            />
          </TestWrapper>,
        );
        expect(
          screen.queryByText("Your computer is disconnected."),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Reconnect" }),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByText("Choose another environment"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("chat-input-agent-context"),
        ).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "Test request" },
        });
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled();
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).not.toHaveClass("bg-red-500/10");
        fireEvent.keyDown(screen.getByRole("textbox"), {
          key: "Enter",
          code: "Enter",
        });
        await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
      },
    );

    it("hides task progress, queued messages, and a live approval after logout", () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      const content = () => (
        <TestWrapper>
          <TaskPanelsSetter />
          <AgentApprovalSetter />
          <ChatInput
            isNewChat
            restoreDraftAttachments={false}
            rateLimitWarning={{
              warningType: "sliding-window",
              remaining: 1,
              resetTime: new Date(Date.now() + 60_000),
              mode: "agent",
              subscription: "free",
            }}
            onDismissRateLimitWarning={jest.fn()}
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>
      );
      const { rerender } = render(content());
      expect(screen.getByText("Private task progress")).toBeInTheDocument();
      expect(screen.getByText("Private queued message")).toBeInTheDocument();
      expect(screen.getByTestId("agent-approval-prompt")).toBeInTheDocument();
      expect(screen.getByTestId("rate-limit-warning")).toBeInTheDocument();
      jest
        .mocked(useAuth)
        .mockReturnValue({ user: null, entitlements: [] } as ReturnType<
          typeof useAuth
        >);
      rerender(content());
      expect(
        screen.queryByText("Private task progress"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Private queued message"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("agent-approval-prompt"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("rate-limit-warning"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });

  describe("Agent Mode Integration", () => {
    beforeEach(() => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
    });
    it.each([
      ["desktop", []],
      ["missing-remote", []],
      ["desktop", ["pro-plan"]],
      ["missing-remote", ["pro-plan"]],
    ] as const)(
      "blocks continue on disconnected %s (%j), preserves the draft, and resumes after reconnect",
      async (sandboxPreference, entitlements) => {
        jest.mocked(useAuth).mockReturnValue({
          user: { id: "user_123" },
          entitlements: [...entitlements],
        } as ReturnType<typeof useAuth>);
        window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
        window.localStorage.setItem("sandbox-preference", sandboxPreference);
        let connections: Array<{
          connectionId: string;
          isDesktop: boolean;
          name: string;
        }> = [];
        mockUseQuery.mockImplementation((query) =>
          getFunctionName(query) === "localSandbox:listConnections"
            ? connections
            : undefined,
        );
        const settingsRequested = jest.fn();
        window.addEventListener("open-settings-dialog", settingsRequested);
        const input = (
          <TestWrapper>
            <SelectedComputerProbe />
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              onSendNow={jest.fn()}
              status="ready"
            />
          </TestWrapper>
        );
        const { rerender } = render(input);
        const textarea = await screen.findByRole("textbox");
        fireEvent.change(textarea, { target: { value: "continue" } });
        fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
        expect(mockOnSubmit).not.toHaveBeenCalled();
        expect(textarea).toHaveValue("continue");
        expect(screen.getByTestId("selected-computer")).toHaveTextContent(
          `agent:${sandboxPreference}`,
        );
        expect(
          screen.getByText("Your computer is disconnected."),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        if (sandboxPreference === "desktop") {
          expect(
            screen.getByText(/Open HackerAI Desktop on your selected computer/),
          ).toBeInTheDocument();
          expect(settingsRequested).not.toHaveBeenCalled();
        } else {
          expect(settingsRequested).toHaveBeenCalledWith(
            expect.objectContaining({ detail: { tab: "Remote Control" } }),
          );
        }
        window.removeEventListener("open-settings-dialog", settingsRequested);
        connections = [
          {
            connectionId: sandboxPreference,
            isDesktop: sandboxPreference === "desktop",
            name: "My computer",
          },
        ];
        rerender(
          <TestWrapper>
            <SelectedComputerProbe />
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              onSendNow={jest.fn()}
              status="ready"
            />
          </TestWrapper>,
        );
        await waitFor(() =>
          expect(
            screen.queryByText("Your computer is disconnected."),
          ).not.toBeInTheDocument(),
        );
        fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
        await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId("selected-computer")).toHaveTextContent(
          `agent:${sandboxPreference}`,
        );
      },
    );

    it.each([true, false])(
      "shows contextual reconnect copy for isNewChat=%s",
      async (isNewChat) => {
        window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
        window.localStorage.setItem("sandbox-preference", "desktop");
        mockUseQuery.mockImplementation((query) =>
          getFunctionName(query) === "localSandbox:listConnections"
            ? []
            : undefined,
        );
        render(
          <TestWrapper>
            <ChatInput
              isNewChat={isNewChat}
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
            />
          </TestWrapper>,
        );
        expect(
          await screen.findByText(
            isNewChat
              ? "Reconnect or choose another environment to start."
              : "Reconnect it to continue this task.",
          ),
        ).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveClass(
          "computer-reconnection-warning",
        );
      },
    );

    it("keeps sandbox controls before progress and queued messages in reading order", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = { chatMode: "agent" };

      render(
        <TestWrapper>
          <TaskPanelsSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
            hasMessages
          />
        </TestWrapper>,
      );

      const progress = await screen.findByRole("button", {
        name: "Expand todos",
      });
      const sandbox = await screen.findByTestId("chat-input-agent-context");
      const queued = screen.getByText("Private queued message");
      const composer = screen.getByTestId("chat-input-surface");
      for (const [before, after] of [
        [sandbox, progress],
        [progress, queued],
        [queued, composer],
      ]) {
        expect(
          before.compareDocumentPosition(after) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it("renders compact Agent controls above the glass composer", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
      mockUseQuery.mockImplementation((query) =>
        getFunctionName(query) === "localSandbox:listConnections"
          ? [
              {
                connectionId: "local-sandbox",
                name: "Local sandbox",
                isDesktop: false,
              },
            ]
          : undefined,
      );

      const { rerender } = render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            hasMessages
          />
        </TestWrapper>,
      );

      await screen.findByTestId("chat-input-surface");
      expect(screen.getByTestId("chat-input-surface")).toHaveClass(
        "chat-input-glass-surface",
        "z-10",
      );
      expect(screen.getByTestId("chat-input-agent-context")).toHaveClass(
        "mb-1",
        "px-2",
        "justify-end",
        "md:hidden",
      );
      expect(
        screen
          .getByTestId("chat-input-agent-context")
          .compareDocumentPosition(screen.getByTestId("chat-input-surface")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByTestId("chat-input-surface")).toHaveClass("order-2");
      expect(screen.getByTestId("chat-input-mobile-sandbox")).toHaveClass(
        "min-w-0",
        "max-w-full",
      );
      expect(screen.getByTestId("chat-input-mobile-permission")).toHaveClass(
        "shrink-0",
        "md:hidden",
      );

      jest
        .mocked(useAuth)
        .mockReturnValue({ user: null, entitlements: [] } as ReturnType<
          typeof useAuth
        >);
      rerender(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            hasMessages
          />
        </TestWrapper>,
      );

      expect(
        screen.queryByTestId("chat-input-agent-context"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-input-desktop-permission"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-input-desktop-sandbox"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it.each(["surface", "writing-area"])(
      "focuses the mobile editor on the first %s tap and accepts a draft",
      async (targetName) => {
        mockIsMobile = true;
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              hasMessages
              autoFocus={false}
            />
          </TestWrapper>,
        );
        const input = await screen.findByTestId("chat-input");
        const target =
          targetName === "surface"
            ? screen.getByTestId("chat-input-surface")
            : input.parentElement!;
        expect(input).not.toHaveFocus();
        fireEvent.click(target);
        expect(input).toHaveFocus();
        fireEvent.change(input, { target: { value: "First tap draft" } });
        expect(input).toHaveValue("First tap draft");
      },
    );

    it("does not focus the editor on a scroll gesture or an upload button click", async () => {
      mockIsMobile = true;
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            status="ready"
            hasMessages
            autoFocus={false}
          />
        </TestWrapper>,
      );
      const input = await screen.findByTestId("chat-input");
      const surface = screen.getByTestId("chat-input-surface");
      fireEvent.pointerDown(surface, { pointerType: "touch" });
      fireEvent.pointerCancel(surface, { pointerType: "touch" });
      expect(input).not.toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
      expect(input).not.toHaveFocus();
    });

    it.each([
      ["add", false],
      ["permissions", false],
      ["model", false],
      ["add", true],
      ["permissions", true],
      ["model", true],
    ] as const)(
      "keeps mobile Cloud visibility unchanged when opening %s with editor previously focused=%s",
      async (control, editorPreviouslyFocused) => {
        mockIsMobile = true;
        jest.mocked(useAuth).mockReturnValue({
          user: { id: "toolbar-focus-user" },
          entitlements: [],
        } as ReturnType<typeof useAuth>);
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ enabled: true }),
        });
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              status="ready"
              hasMessages
              autoFocus={false}
            />
          </TestWrapper>,
        );
        const input = await screen.findByRole("textbox");
        const add = await screen.findByRole("button", {
          name: "Add files or pursue a goal",
        });
        const context = screen.getByTestId("chat-input-agent-context");
        const trigger =
          control === "add"
            ? add
            : screen.getByRole("button", {
                name:
                  control === "permissions" ? /^Agent permissions:/ : "Auto",
              });

        if (editorPreviouslyFocused) act(() => input.focus());
        act(() => trigger.focus());
        expect(context.hasAttribute("inert")).toBe(!editorPreviouslyFocused);
        expect(input).not.toHaveFocus();

        if (control === "add") fireEvent.keyDown(trigger, { key: "Enter" });
        else fireEvent.click(trigger);
        const popup = await screen.findByRole(
          control === "add" ? "menu" : "dialog",
        );
        await waitFor(() =>
          expect(popup).toContainElement(document.activeElement),
        );
        expect(context.hasAttribute("inert")).toBe(!editorPreviouslyFocused);

        if (control === "model") {
          fireEvent.click(within(popup).getByRole("button", { name: /^Auto/ }));
        } else fireEvent.keyDown(popup, { key: "Escape" });
        await waitFor(() => expect(popup).not.toBeInTheDocument());
        expect(context.hasAttribute("inert")).toBe(!editorPreviouslyFocused);

        fireEvent.pointerDown(document.body);
        expect(context).toHaveAttribute("inert");
      },
    );

    it("hides the sandbox after leaving an existing mobile composer but keeps new chats visible", async () => {
      mockIsMobile = true;
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
      mockUseQuery.mockImplementation((query) =>
        getFunctionName(query) === "localSandbox:listConnections"
          ? [
              {
                connectionId: "local-sandbox",
                name: "Local sandbox",
                isDesktop: false,
              },
            ]
          : undefined,
      );

      const { rerender } = render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            hasMessages
            autoFocus={false}
          />
        </TestWrapper>,
      );

      const context = await screen.findByTestId("chat-input-agent-context");
      const input = screen.getByTestId("chat-input");
      expect(context).toHaveAttribute("aria-hidden", "true");
      expect(context).toHaveAttribute("inert");
      expect(
        screen.getByRole("button", { name: /^Agent permissions:/ }),
      ).toBeInTheDocument();

      fireEvent.focus(input);
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");

      fireEvent.blur(input, { relatedTarget: null });
      expect(context).toHaveAttribute("aria-hidden", "true");
      expect(context).toHaveAttribute("inert");
      fireEvent.focus(input);

      fireEvent.change(input, { target: { value: "A harmless follow-up" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");

      const sandboxTrigger = screen
        .getByTestId("chat-input-mobile-sandbox")
        .querySelector("button");
      expect(sandboxTrigger).not.toBeNull();
      act(() => input.focus());
      fireEvent.pointerDown(sandboxTrigger!, { pointerType: "touch" });
      jest.useFakeTimers();
      try {
        fireEvent.pointerUp(sandboxTrigger!, { pointerType: "touch" });
        // Safari may deliver compatibility mouse events in a later task,
        // blurring the textarea without focusing the tapped button.
        act(() => jest.advanceTimersByTime(0));
        act(() => input.blur());
        expect(context).not.toHaveAttribute("aria-hidden", "true");
        expect(context).not.toHaveAttribute("inert");
      } finally {
        jest.useRealTimers();
      }

      fireEvent.click(sandboxTrigger!);
      const menu = await waitFor(() => {
        const openedMenu = document.querySelector(
          "[data-chat-input-agent-menu]",
        );
        expect(openedMenu).toBeInTheDocument();
        return openedMenu;
      });
      jest.useFakeTimers();
      try {
        fireEvent.pointerUp(sandboxTrigger!);
        act(() => jest.runOnlyPendingTimers());
        expect(context).not.toHaveAttribute("inert");
      } finally {
        jest.useRealTimers();
      }
      fireEvent.pointerDown(menu!);
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");

      fireEvent.pointerDown(document.body);
      expect(context).toHaveAttribute("aria-hidden", "true");
      expect(context).toHaveAttribute("inert");

      fireEvent.pointerDown(input, { pointerType: "touch" });
      expect(context).toHaveAttribute("inert");
      fireEvent.focus(input);
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");

      fireEvent.pointerDown(document.body);
      expect(context).toHaveAttribute("aria-hidden", "true");
      expect(context).toHaveAttribute("inert");
      rerender(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat
            autoFocus={false}
          />
        </TestWrapper>,
      );
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");
      fireEvent.pointerDown(document.body);
      expect(context).not.toHaveAttribute("aria-hidden", "true");
      expect(context).not.toHaveAttribute("inert");
    });

    it.each([
      ["sandbox", "pointerup"],
      ["permissions", "pointercancel"],
    ])(
      "keeps %s usable through delayed touch blur until %s",
      async (target, release) => {
        mockIsMobile = true;
        jest.mocked(useAuth).mockReturnValue({
          user: { id: "user_123" },
          entitlements: [],
        } as ReturnType<typeof useAuth>);
        window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
        mockUseQuery.mockImplementation((query) =>
          getFunctionName(query) === "localSandbox:listConnections"
            ? [
                {
                  connectionId: "local-sandbox",
                  name: "Local sandbox",
                  isDesktop: false,
                },
              ]
            : undefined,
        );
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
              hasMessages
              autoFocus={false}
            />
          </TestWrapper>,
        );
        const context = await screen.findByTestId("chat-input-agent-context");
        const input = screen.getByTestId("chat-input");
        const trigger =
          target === "sandbox"
            ? screen
                .getByTestId("chat-input-mobile-sandbox")
                .querySelector("button")!
            : screen.getByRole("button", { name: /^Agent permissions:/ });
        jest.useFakeTimers();
        try {
          act(() => input.focus());
          fireEvent.pointerDown(input, { pointerType: "touch" });
          fireEvent.pointerUp(input, { pointerType: "touch" });
          act(() => jest.runOnlyPendingTimers());
          expect(context).not.toHaveAttribute("inert");

          fireEvent.pointerDown(trigger, { pointerType: "touch" });
          act(() => jest.advanceTimersByTime(100));
          act(() => input.blur());
          expect(context).not.toHaveAttribute("aria-hidden", "true");
          expect(context).not.toHaveAttribute("inert");

          fireEvent(document, new Event(release, { bubbles: true }));
          act(() => jest.runOnlyPendingTimers());
          expect(context).toHaveAttribute("aria-hidden", "true");
          expect(context).toHaveAttribute("inert");
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it("keeps desktop controls when the sidebar narrows the composer", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, "agent");
      mockUseQuery.mockImplementation((query) =>
        getFunctionName(query) === "localSandbox:listConnections"
          ? [
              {
                connectionId: "local-sandbox",
                name: "Local sandbox",
                isDesktop: false,
              },
            ]
          : undefined,
      );

      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      const rectSpy = jest
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const rect = originalRect.call(this);
          return this.dataset.testid === "chat-input-container"
            ? { ...rect, width: 700 }
            : rect;
        });

      try {
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
              hasMessages
            />
          </TestWrapper>,
        );

        await screen.findByTestId("chat-input-surface");
        expect(screen.getByTestId("chat-input-agent-context")).toHaveClass(
          "md:hidden",
        );
        expect(screen.getByTestId("chat-input-desktop-permission")).toHaveClass(
          "md:block",
        );
        expect(screen.getByTestId("chat-input-desktop-sandbox")).toHaveClass(
          "md:block",
        );
      } finally {
        rectSpy.mockRestore();
      }
    });

    it("does not show a late approval after the composer stop button is clicked", async () => {
      let resolveStop: ((stopped: boolean) => void) | undefined;
      const pendingStop = new Promise<boolean>((resolve) => {
        resolveStop = resolve;
      });
      const stop = jest.fn(() => pendingStop);
      const approvalRequest = {
        approvalId: "late-approval-1",
        toolCallId: "tool-1",
        title: "Allow HackerAI to run this terminal command?",
        target: "curl https://hackerai.co",
        detail: "Approve to continue, or deny to stop this command.",
        kind: "terminal" as const,
        operation: "terminal_execute",
      };
      const renderChatInput = (
        status: "ready" | "streaming",
        storedApprovalRequest: typeof approvalRequest | null,
      ) => (
        <TestWrapper>
          <AgentModeSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={stop}
            status={status}
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={storedApprovalRequest}
          />
        </TestWrapper>
      );
      const { rerender } = render(renderChatInput("streaming", null));

      fireEvent.click(screen.getByLabelText("Stop generation"));
      rerender(renderChatInput("streaming", approvalRequest));

      expect(stop).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId("agent-approval-prompt"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Reconnecting to the Agent approval session..."),
      ).not.toBeInTheDocument();

      await act(async () => resolveStop?.(true));
      rerender(renderChatInput("ready", null));
      rerender(renderChatInput("ready", approvalRequest));

      expect(screen.getByTestId("agent-approval-prompt")).toBeInTheDocument();
    });

    it.each(["wait", "goal"])(
      "submits question choices and a custom composer answer for %s, preserving them after failure",
      async (kind) => {
        const errorToast = jest.spyOn(toast, "error").mockReturnValue(0);
        const infoToast = jest.spyOn(toast, "info").mockReturnValue(0);
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        if (kind === "goal")
          mockOnSubmit.mockRejectedValue(
            new GoalSubmissionUnconfirmedError(true, "questions-chat"),
          );
        else mockOnSubmit.mockResolvedValue(false);
        const questions = [
          {
            id: "scope",
            header: "Scope",
            question: "Choose scopes",
            multiSelect: true,
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
          },
          {
            id: "format",
            header: "Format",
            question: "Which format?",
            options: [],
          },
        ];
        render(
          <TestWrapper>
            <ChatInput
              chatId="questions-chat"
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              onSendNow={jest.fn()}
              status="ready"
              {...(kind === "wait"
                ? {
                    pendingUserWait: {
                      runId: "run-question",
                      toolCallId: "tool-question",
                      status: "waiting" as const,
                      questions,
                    },
                  }
                : { pendingGoalQuestions: { generation: 4, questions } })}
            />
          </TestWrapper>,
        );
        const alpha = await screen.findByRole("button", { name: /Alpha/ });
        await waitFor(() => expect(alpha).toBeEnabled());
        fireEvent.click(alpha);
        fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
        fireEvent.click(
          screen.getByRole("button", { name: "Next", exact: true }),
        );
        const input = screen.getByRole("textbox");
        const longAnswer = "x".repeat(20_000);
        fireEvent.change(input, { target: { value: longAnswer } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(mockOnSubmit).not.toHaveBeenCalled();
        expect(errorToast).toHaveBeenCalledWith(
          "Could not send your answers",
          expect.objectContaining({
            description: expect.stringContaining("20,000"),
          }),
        );
        expect(input).toHaveValue(longAnswer);
        fireEvent.change(input, { target: { value: "/goal literal answer" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
          expect(mockOnSubmit).toHaveBeenCalledWith(
            expect.anything(),
            "Choose scopes\nAlpha, Beta\n\nWhich format?\n/goal literal answer",
            true,
          ),
        );
        expect(input).toHaveValue("/goal literal answer");
        if (kind === "goal") {
          expect(infoToast).toHaveBeenCalledWith(
            expect.stringContaining("Check its chat before sending again"),
            expect.objectContaining({
              action: expect.objectContaining({ label: "Check chat" }),
            }),
          );
          expect(errorToast).toHaveBeenCalledTimes(1);
        }
        fireEvent.click(
          screen.getByRole("button", { name: "Back", exact: true }),
        );
        expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(screen.getByRole("button", { name: /Beta/ })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(
          mockGoalCapture.mock.calls.filter(
            ([event]) => event === "agent_input_questions_exposed",
          ),
        ).toEqual([
          [
            "agent_input_questions_exposed",
            {
              definition_version: 1,
              source: kind === "wait" ? "wait_for_user" : "goal",
              question_count: 2,
            },
          ],
        ]);
        errorToast.mockRestore();
        infoToast.mockRestore();
      },
    );

    it.each(["wait", "goal"])(
      "respects computer restrictions for %s questions",
      async (kind) => {
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        const questions = [
          {
            id: "answer",
            header: "Answer",
            question: "What next?",
            options: [],
          },
        ];
        render(
          <TestWrapper>
            <ChatInput
              chatId="restricted-questions"
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
              sendDisabledReason="Reconnect your computer"
              {...(kind === "wait"
                ? {
                    pendingUserWait: {
                      runId: "run",
                      toolCallId: "call",
                      status: "waiting" as const,
                      questions,
                    },
                  }
                : { pendingGoalQuestions: { generation: 1, questions } })}
            />
          </TestWrapper>,
        );
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "Continue" },
        });
        const submit = screen.getByRole("button", {
          name: "Submit answer",
          exact: true,
        });
        if (kind === "goal") {
          expect(submit).toBeDisabled();
          fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
          expect(mockOnSubmit).not.toHaveBeenCalled();
        } else {
          await waitFor(() => expect(submit).toBeEnabled());
          fireEvent.click(submit);
          await waitFor(() =>
            expect(mockOnSubmit).toHaveBeenCalledWith(
              expect.anything(),
              "Continue",
              true,
            ),
          );
        }
      },
    );

    it("replaces the composer with an approval selector while awaiting approval", async () => {
      render(
        <TestWrapper>
          <AgentApprovalSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
            chatId="approval-chat"
            hasMessages
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByTestId("agent-approval-prompt"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Allow once" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "More approval options" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
      expect(
        screen.getByText("Check whether the target host is reachable."),
      ).toBeInTheDocument();
      expect(screen.getByText("ping -c 4 hackerone.com")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-input")).not.toBeVisible();
    });

    it.each(["streaming", "error"] as const)(
      "shows a reply prompt and sends during a paused Agent run with %s status",
      async (status) => {
        jest.mocked(useAuth).mockReturnValue({
          user: { id: "user_123" },
          entitlements: [],
        } as ReturnType<typeof useAuth>);
        render(
          <TestWrapper>
            <AgentModeSetter />
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status={status}
              chatId="reply-chat"
              hasMessages
              pendingUserWait={{
                runId: "run-1",
                toolCallId: "tool-1",
                status: "waiting",
              }}
            />
          </TestWrapper>,
        );

        expect(
          await screen.findByTestId("waiting-for-reply-banner"),
        ).toHaveTextContent("Waiting for your reply");
        const input = screen.getByRole("textbox");
        expect(input).toHaveAttribute(
          "aria-describedby",
          "waiting-for-reply-description",
        );
        fireEvent.change(input, { target: { value: "Use the first option" } });
        const send = screen.getByRole("button", {
          name: "Send reply and resume agent",
        });
        expect(send).toBeEnabled();
        fireEvent.click(send);
        await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
      },
    );

    it("merges the stored reviewer summary into the matching live approval", async () => {
      render(
        <TestWrapper>
          <AgentApprovalSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              operation: "terminal_execute",
              autoReview: {
                verdict: "ask_user",
                riskCategory: "scope_expansion",
                rationale: "The referenced script contents are not visible.",
                rolloutPhase: "enforce",
              },
            }}
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByTestId("agent-auto-review-summary"),
      ).toHaveTextContent("This action needs your approval");
      expect(screen.getByText("ping -c 4 hackerone.com")).toBeInTheDocument();
    });

    it("renders recovery controls while a stored approval reconnects", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      expect(screen.getByTestId("agent-approval-prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Reconnecting to the Agent approval session..."),
      ).toBeInTheDocument();
      expect(screen.getByText("ping -c 4 hackerone.com")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Allow once" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("chat-input")).not.toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

      expect(mockOnStop).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText("Reconnecting to the Agent approval session..."),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    });

    it("clears the approval prompt when the persisted lifecycle resolves", async () => {
      const storedApprovalRequest = {
        approvalId: "stored-approval-1",
        toolCallId: "tool-1",
        title: "Allow HackerAI to run this terminal command?",
        target: "ping -c 4 hackerone.com",
        detail: "Approve to continue, or deny to stop this command.",
        kind: "terminal" as const,
        operation: "terminal_execute" as const,
      };
      const renderInput = (request: typeof storedApprovalRequest | null) => (
        <TestWrapper>
          <AgentModeSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={request}
          />
        </TestWrapper>
      );
      const { rerender } = render(renderInput(storedApprovalRequest));

      rerender(renderInput(null));

      expect(
        screen.queryByTestId("agent-approval-prompt"),
      ).not.toBeInTheDocument();
      expect(await screen.findByTestId("chat-input")).toBeInTheDocument();
    });

    it("shows a neutral input shell until the initial task state resolves", async () => {
      render(
        <TestWrapper>
          <AgentModeSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            isResolvingInitialState
            topNotice={<button>Take control</button>}
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByTestId("chat-input-loading-state"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Take control" }),
      ).toBeVisible();
      expect(screen.getByTestId("chat-input-loading-surface")).toHaveClass(
        "h-[98px]",
      );
      expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("agent-approval-prompt"),
      ).not.toBeInTheDocument();
    });

    it("restores the approval prompt when stopping the Agent fails", async () => {
      const failedStop = jest.fn(async () => false);

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={failedStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

      await waitFor(() =>
        expect(
          screen.getByText("Reconnecting to the Agent approval session..."),
        ).toBeInTheDocument(),
      );
      expect(failedStop).toHaveBeenCalledTimes(1);
    });

    it("keeps free-account recovery controls when stored approval reconnection fails", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ assignment: { variant: "test", country: "IN" } }),
      });
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onReconnect={mockOnReconnect}
            status="error"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      expect(
        screen.getByText("Could not reconnect to the Agent approval session."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Retry connection" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Stop agent" }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

      expect(mockOnReconnect).toHaveBeenCalledTimes(1);
      await act(async () => {});
      expect(
        screen.queryByTestId("regional-subscription-offer"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop agent" })).toBeVisible();
    });

    it("keeps connected approval actions available to a free account after a stream error", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ assignment: { variant: "test", country: "IN" } }),
      });
      render(
        <TestWrapper>
          <AgentApprovalSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onReconnect={mockOnReconnect}
            status="error"
            chatId="approval-chat"
            hasMessages
          />
        </TestWrapper>,
      );
      expect(
        await screen.findByRole("button", { name: "Allow once" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Deny" })).toBeVisible();
      expect(
        screen.queryByTestId("regional-subscription-offer"),
      ).not.toBeInTheDocument();
    });

    it("keeps a persisted Agent reply available to a free account after reload", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = { subscription: "free", isCheckingProPlan: false };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ assignment: { variant: "test", country: "IN" } }),
      });
      render(
        <TestWrapper>
          <AgentModeSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            chatId="waiting-chat"
            hasMessages
            pendingUserWait={{
              runId: "run-1",
              toolCallId: "tool-1",
              status: "waiting",
            }}
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByTestId("waiting-for-reply-banner"),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Stop agent instead of replying" }),
      ).toBeVisible();
      expect(
        screen.queryByTestId("regional-subscription-offer"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Submit Behavior Integration", () => {
    it("removes an accepted attachment draft without changing the chat id", async () => {
      const file: UploadedFileState = {
        file: new File(["image"], "stable.png", { type: "image/png" }),
        uploaded: true,
        uploading: false,
        storage: "s3",
        fileId: "stable-file",
        tokens: 12,
      };
      render(
        <TestWrapper>
          <UploadedFilesSetter files={[file]} label="Attach stable file" />
          <StableAttachmentSubmitHarness />
        </TestWrapper>,
      );
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Submit attachment" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Attach stable file" }),
      );
      expect(await screen.findByAltText("stable.png")).toBeInTheDocument();
      await waitFor(() =>
        expect(getDraftAttachmentsById("stable-attachment")).toHaveLength(1),
      );
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("");
        expect(screen.queryByAltText("stable.png")).not.toBeInTheDocument();
        expect(getDraftContentById("stable-attachment")).toBeNull();
        expect(getDraftAttachmentsById("stable-attachment")).toEqual([]);
      });
    });

    it("accepts an Enter submission during startup before the first model response", async () => {
      const submit = jest.fn(async () => true);
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={submit}
            onStop={mockOnStop}
            status="submitted"
            chatId="startup-summary"
          />
        </TestWrapper>,
      );
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Steer during preparation" },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    });

    it.each(["rejected", "throws"])(
      "blocks duplicate Enter presses and unlocks after a submission %s",
      async (outcome) => {
        let finish!: (accepted: boolean) => void;
        let fail!: (error: Error) => void;
        const pending = new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        const submit = jest
          .fn(async () => true)
          .mockImplementationOnce(() => pending);
        const log = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
          render(
            <TestWrapper>
              <ChatInput
                onSubmit={submit}
                onStop={mockOnStop}
                status="streaming"
                chatId="pending"
              />
            </TestWrapper>,
          );
          const input = screen.getByRole("textbox");
          fireEvent.change(input, { target: { value: "One submission" } });
          fireEvent.keyDown(input, { key: "Enter" });
          fireEvent.keyDown(input, { key: "Enter" });
          expect(submit).toHaveBeenCalledTimes(1);
          await act(async () => {
            if (outcome === "throws")
              fail(new Error("Synthetic admission failure"));
            else finish(false);
          });
          expect(input).toHaveValue("One submission");
          fireEvent.keyDown(input, { key: "Enter" });
          await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
        } finally {
          log.mockRestore();
        }
      },
    );

    it("keeps edits and attachments made while admission is pending", async () => {
      let finish!: (accepted: boolean) => void;
      const submit = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const nextFile: UploadedFileState = {
        file: new File(["image"], "next.png", { type: "image/png" }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "next-file",
        url: "https://example.com/next.png",
        tokens: 12,
      };
      render(
        <TestWrapper>
          <UploadedFilesSetter files={[nextFile]} label="Attach next draft" />
          <ChatInput
            onSubmit={submit}
            onStop={mockOnStop}
            status="streaming"
            chatId="pending-edit"
          />
        </TestWrapper>,
      );
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Original submission" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.change(input, { target: { value: "New draft" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Attach next draft" }),
      );
      await act(async () => finish(true));
      expect(input).toHaveValue("New draft");
      expect(await screen.findByAltText("next.png")).toBeInTheDocument();
      await waitFor(() => {
        expect(getDraftContentById("pending-edit")).toBe("New draft");
        expect(getDraftAttachmentsById("pending-edit")).toHaveLength(1);
      });
    });

    it("does not clear a new chat's draft when an unmounted composer finishes admission", async () => {
      let finish!: (accepted: boolean) => void;
      const submit = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const view = (chatId: string) => (
        <TestWrapper>
          <ChatInput
            key={chatId}
            onSubmit={submit}
            onStop={mockOnStop}
            status="streaming"
            chatId={chatId}
          />
        </TestWrapper>
      );
      const { rerender } = render(view("old-chat"));
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Same text" },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      rerender(view("new-chat"));
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Same text" },
      });
      await act(async () => finish(true));
      expect(screen.getByRole("textbox")).toHaveValue("Same text");
      await waitFor(() =>
        expect(getDraftContentById("new-chat")).toBe("Same text"),
      );
    });

    it("does not restore a sent attachment when a new chat gets its real draft id", async () => {
      const uploadedFile: UploadedFileState = {
        file: new File(["image"], "screenshot.png", { type: "image/png" }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_screenshot",
        tokens: 12,
      };

      render(
        <TestWrapper>
          <NewChatAttachmentSubmitHarness uploadedFile={uploadedFile} />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Attach file"));
      expect(await screen.findByAltText("screenshot.png")).toBeInTheDocument();

      await waitFor(() => {
        expect(getDraftAttachmentsById("new")).toHaveLength(1);
      });

      fireEvent.click(screen.getByLabelText("Send message"));

      await waitFor(() => {
        expect(screen.queryByAltText("screenshot.png")).not.toBeInTheDocument();
        expect(getDraftAttachmentsById("new")).toEqual([]);
        expect(getDraftAttachmentsById("chat-1")).toEqual([]);
      });
    });

    it("migrates restored pasted-text attachments when a new chat gets its real id", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        tokens: 120,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "new",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      const { rerender } = render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={true}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();

      rerender(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "chat-1",
              attachments: [
                expect.objectContaining({
                  ...draftAttachment,
                  generatedSource: "pasted-text",
                }),
              ],
            }),
          ]),
        );
      });
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(
        store.drafts.some((draft: { id: string }) => draft.id === "new"),
      ).toBe(false);
      expect(screen.getByText("pasted-text.txt")).toBeInTheDocument();
    });

    it("uses the real chat draft once a persistent new chat has messages", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={true}
            hasMessages={true}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
    });

    it("restores pasted-text draft attachments with editable content", async () => {
      const pastedContent = "Original pasted source material";
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_123",
        timestamp: Date.now(),
      };
      mockUseQuery.mockImplementation((_query, args) =>
        args &&
        args !== "skip" &&
        Array.isArray((args as { fileIds?: unknown }).fileIds)
          ? [
              {
                id: "file_123",
                name: "pasted-text.txt",
                mediaType: "text/plain",
                content: pastedContent,
                tokenSize: 120,
              },
            ]
          : undefined,
      );
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByLabelText("Open pasted-text.txt"),
        ).not.toBeDisabled(),
      );

      fireEvent.click(screen.getByLabelText("Open pasted-text.txt"));
      expect(screen.getByLabelText("Pasted text content")).toHaveValue(
        pastedContent,
      );
      expect(
        screen.getByText("Changes save automatically as you edit"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Pasted text content")).not.toBeDisabled();
      expect(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
      ).not.toContain(pastedContent);
      expect(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
      ).toContain("generated_123");
    });

    it("restores local generated pasted-text drafts from the Desktop file", async () => {
      const pastedContent = "Local pasted source material";
      const localPath = "/Users/alice/pasted_content.txt";
      const draftAttachment = {
        kind: "pasted-text" as const,
        storage: "local-desktop" as const,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_local_123",
        timestamp: Date.now(),
      };
      mockReadGeneratedTextAttachment.mockResolvedValue({
        path: localPath,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: pastedContent.length,
        lastModified: 123456,
        content: pastedContent,
      });
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted_content.txt")).toBeInTheDocument();
      await waitFor(() =>
        expect(mockReadGeneratedTextAttachment).toHaveBeenCalledWith(
          "generated_local_123",
          "pasted_content.txt",
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByLabelText("Open pasted_content.txt"),
        ).not.toBeDisabled(),
      );

      fireEvent.click(screen.getByLabelText("Open pasted_content.txt"));
      expect(screen.getByLabelText("Pasted text content")).toHaveValue(
        pastedContent,
      );
      const storedDraft = window.localStorage.getItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
      );
      expect(storedDraft).not.toContain(pastedContent);
      expect(storedDraft).not.toContain(localPath);
    });

    it("keeps an unavailable local pasted-text draft without exposing content", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        storage: "local-desktop" as const,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_local_missing",
        timestamp: Date.now(),
      };
      mockReadGeneratedTextAttachment.mockResolvedValue(null);
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByText("Unavailable on this device"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Open pasted_content.txt")).toBeDisabled();
      await waitFor(() =>
        expect(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
        ).toContain("generated_local_missing"),
      );
    });

    it("restores regular S3 draft attachments", async () => {
      const draftAttachment = {
        kind: "file" as const,
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        tokens: 42,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    });

    it("does not restore draft attachments when attachment restoration is disabled", async () => {
      const draftAttachment = {
        kind: "file" as const,
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "new",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onSendNow={jest.fn()}
            status="ready"
            isNewChat={true}
            restoreDraftAttachments={false}
          />
        </TestWrapper>,
      );

      await act(async () => {});

      expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(store.drafts[0].attachments).toEqual([draftAttachment]);
    });

    it("persists regular S3 uploaded files into draft attachments", async () => {
      const browserFile = new File(["x".repeat(2048)], "report.pdf", {
        type: "application/pdf",
        lastModified: 123456,
      });
      const pendingFile: UploadedFileState = {
        file: browserFile,
        uploading: true,
        uploaded: false,
        storage: "s3",
      };
      const uploadedFile: UploadedFileState = {
        file: browserFile,
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_regular",
        tokens: 84,
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[pendingFile]} label="Start upload" />
          <UploadedFilesSetter files={[uploadedFile]} label="Complete upload" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      await act(async () => {});
      fireEvent.click(screen.getByText("Start upload"));
      await waitFor(() => {
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
      });
      await act(async () => {});
      const beforeCompletion = Date.now();
      fireEvent.click(screen.getByText("Complete upload"));

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              {
                kind: "file",
                fileId: "file_regular",
                name: "report.pdf",
                mediaType: "application/pdf",
                size: 2048,
                tokens: 84,
                timestamp: expect.any(Number),
              },
            ],
          }),
        ]);
        expect(store.drafts[0].attachments[0].timestamp).toBeGreaterThanOrEqual(
          beforeCompletion,
        );
      });
    });

    it("persists generated pasted-text metadata without draft content", async () => {
      const pastedContent = "Original pasted source material";
      const browserFile = new File([pastedContent], "pasted_content.txt", {
        type: "text/plain",
        lastModified: 123456,
      });
      const uploadedFile: UploadedFileState = {
        file: browserFile,
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_pasted",
        tokens: 84,
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: "generated_123",
          content: pastedContent,
        },
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Complete upload" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Complete upload"));

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              expect.objectContaining({
                kind: "pasted-text",
                fileId: "file_pasted",
                name: "pasted_content.txt",
                mediaType: "text/plain",
                size: pastedContent.length,
                tokens: 84,
                generatedSource: "pasted-text",
                generatedTextAttachmentId: "generated_123",
              }),
            ],
          }),
        ]);
        expect(JSON.stringify(store)).not.toContain(pastedContent);
      });
    });

    it("keeps the committed pasted-text draft while an edit is uploading", async () => {
      const previousContent = "Previously saved source material";
      const editedContent = "Edited source material";
      const uploadedFile: UploadedFileState = {
        file: new File([editedContent], "pasted_content.txt", {
          type: "text/plain",
          lastModified: 234567,
        }),
        uploading: true,
        uploaded: false,
        storage: "s3",
        fileId: "file_pasted_previous",
        tokens: 84,
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: "generated_123",
          content: editedContent,
        },
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Start edit" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Start edit"));

      await waitFor(() => {
        const storedDraft =
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "";
        expect(storedDraft).toContain("file_pasted_previous");
        expect(storedDraft).toContain("generated_123");
        expect(storedDraft).not.toContain(previousContent);
        expect(storedDraft).not.toContain(editedContent);
      });
    });

    it("keeps restored pasted-text drafts when submit is rejected", async () => {
      const rejectedSubmit = jest.fn(() => false);
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={rejectedSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Send message"));

      await waitFor(() => expect(rejectedSubmit).toHaveBeenCalledTimes(1));
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(store.drafts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              expect.objectContaining({
                ...draftAttachment,
                generatedSource: "pasted-text",
              }),
            ],
          }),
        ]),
      );
    });

    it("should disable submit when no input", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const submitButton = screen.getByLabelText("Send message");
      expect(submitButton).toBeDisabled();
    });

    it("should handle submitted status correctly", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="submitted"
          />
        </TestWrapper>,
      );

      // Component should render without errors in submitted status
      expect(
        screen.getByPlaceholderText("Ask, learn, brainstorm"),
      ).toBeInTheDocument();
    });

    it("should handle enter key to submit", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const textarea = screen.getByPlaceholderText("Ask, learn, brainstorm");

      // Type some text
      fireEvent.change(textarea, { target: { value: "Test message" } });

      // Press enter
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(mockOnSubmit).toHaveBeenCalledTimes(1);
    });

    it("should not submit on shift+enter", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const textarea = screen.getByPlaceholderText("Ask, learn, brainstorm");

      // Type some text
      fireEvent.change(textarea, { target: { value: "Test message" } });

      // Press shift+enter (should add newline, not submit)
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe("Rate Limit Warning Integration", () => {
    it("uses the smaller warning only while Todos is visible above the composer", async () => {
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "user_123" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = {
        todos: [
          { id: "todo-1", content: "Check domain", status: "in_progress" },
        ],
        sidebarOpen: false,
      };
      const warning = {
        warningType: "sliding-window" as const,
        remaining: 1,
        resetTime: new Date(Date.now() + 60_000),
        mode: "agent" as const,
        subscription: "free" as const,
      };
      const content = () => (
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            rateLimitWarning={warning}
            onDismissRateLimitWarning={jest.fn()}
          />
        </TestWrapper>
      );

      const { rerender } = render(content());
      await screen.findByTestId("rate-limit-warning");
      expect(screen.getByTestId("rate-limit-warning")).toHaveClass("mx-4");
      expect(screen.getByTestId("rate-limit-warning")).toHaveClass("py-1.5");

      mockSandboxState = { ...mockSandboxState, sidebarOpen: true };
      rerender(content());
      expect(screen.getByTestId("rate-limit-warning")).not.toHaveClass("mx-4");
      expect(screen.getByTestId("rate-limit-warning")).toHaveClass("py-2.5");

      mockSandboxState = { todos: [], sidebarOpen: false };
      rerender(content());
      expect(screen.getByTestId("rate-limit-warning")).not.toHaveClass("mx-4");
    });
  });

  it("moves goal controls clear of files, approvals, and mobile panels without remounting their draft", async () => {
    jest.mocked(useAuth).mockReturnValue({
      user: { id: "user_123" },
      entitlements: [],
    } as ReturnType<typeof useAuth>);
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    const panel = (placement: "attached" | "detached") => (
      <input
        aria-label="Goal reply draft"
        defaultValue=""
        data-placement={placement}
      />
    );
    const approval = {
      approvalId: "goal-approval",
      toolCallId: "goal-tool",
      title: "Approve command",
      target: "printf goal-ok",
      detail: "Waiting for approval",
      kind: "terminal" as const,
    };
    const content = (request?: typeof approval) => (
      <TestWrapper>
        <ChatInput
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          onSendNow={jest.fn()}
          status="ready"
          goalPanel={panel}
          storedApprovalRequest={request}
        />
      </TestWrapper>
    );
    const { rerender } = render(content());
    const reply = await screen.findByRole("textbox", {
      name: "Goal reply draft",
    });
    fireEvent.change(reply, { target: { value: "Keep these instructions" } });
    expect(reply).toHaveAttribute("data-placement", "attached");
    mockSandboxState = {
      ...mockSandboxState,
      uploadedFiles: [
        {
          file: new File(["goal"], "goal.txt", { type: "text/plain" }),
          fileId: "goal-file",
          uploaded: true,
          uploading: false,
        },
      ] as UploadedFileState[],
    };
    rerender(content());
    expect(reply).toHaveAttribute("data-placement", "detached");
    expect(screen.getByRole("textbox", { name: "Goal reply draft" })).toBe(
      reply,
    );
    expect(reply).toHaveValue("Keep these instructions");
    mockSandboxState = { ...mockSandboxState, uploadedFiles: [] };
    rerender(content(approval));
    expect(reply).toHaveAttribute("data-placement", "detached");
    expect(reply).toBeVisible();
    expect(reply).toHaveValue("Keep these instructions");
    rerender(content());
    expect(reply).toHaveAttribute("data-placement", "attached");
    mockIsMobile = true;
    rerender(content());
    expect(reply).toHaveAttribute("data-placement", "detached");
    expect(screen.getByRole("textbox", { name: "Goal reply draft" })).toBe(
      reply,
    );
    expect(reply).toHaveValue("Keep these instructions");
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "preserves inline goal text while an IME candidate is being confirmed: %j",
    async (compositionEvent) => {
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      });
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, { target: { value: "日本語 /goal" } });
      await screen.findByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      });
      for (const key of ["Tab", "Enter", "Escape"]) {
        fireEvent.keyDown(input, { key, ...compositionEvent });
        expect(input).toHaveValue("日本語 /goal");
        expect(
          screen.getByRole("button", {
            name: "Goal Set a goal to keep pursuing",
          }),
        ).toBeVisible();
        expect(mockOnSubmit).not.toHaveBeenCalled();
      }
      fireEvent.keyDown(input, { key: "Tab" });
      expect(input).toHaveValue("日本語");
      fireEvent.keyDown(input, { key: "Escape", ...compositionEvent });
      expect(input).toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
    },
  );

  it.each([
    {
      hasActiveGoalRun: false,
      pauseGoalOnSend: false,
      preference: true,
      requests: 1,
    },
    {
      hasActiveGoalRun: false,
      pauseGoalOnSend: false,
      preference: false,
      requests: 0,
    },
    {
      hasActiveGoalRun: false,
      pauseGoalOnSend: false,
      preference: undefined,
      requests: 0,
    },
    {
      hasActiveGoalRun: true,
      pauseGoalOnSend: false,
      preference: true,
      requests: 0,
    },
    {
      hasActiveGoalRun: false,
      pauseGoalOnSend: true,
      preference: true,
      requests: 0,
    },
  ])(
    "gates next-message predictions on preference readiness and goal ownership: %j",
    async ({ hasActiveGoalRun, pauseGoalOnSend, requests, preference }) => {
      mockUseQuery.mockImplementation((query) =>
        getFunctionName(query) ===
          "userCustomization:getPredictionPreference" &&
        preference !== undefined
          ? { enabled: preference }
          : undefined,
      );
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "prediction-user" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      sessionStorage.clear();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true, suggestions: [] }),
      });
      render(
        <TestWrapper>
          <ChatInput
            chatId="goal-prediction-chat"
            completedPredictionTurn={{
              chatId: "goal-prediction-chat",
              messageId: "answer",
            }}
            latestMessageId="answer"
            hasActiveGoalRun={hasActiveGoalRun}
            pauseGoalOnSend={pauseGoalOnSend}
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
      });
      expect(
        mockFetch.mock.calls.filter(
          ([url]) => url === "/api/chat/next-actions",
        ),
      ).toHaveLength(requests);
      expect(mockOnSubmit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "restores a goal draft on reload and submits it as a goal (mobile=%s)",
    async (mobile) => {
      mockIsMobile = mobile;
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "restore-goal-user" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
        chatModeAccessResolved: true,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      });
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "restore-goal",
              content: "Verify this goal",
              goalMode: true,
              timestamp: Date.now(),
            },
          ],
        }),
      );
      const ui = () => (
        <TestWrapper>
          <ChatInput
            chatId="restore-goal"
            onSubmit={mockOnSubmit}
            status="ready"
          />
        </TestWrapper>
      );
      mockOnSubmit.mockResolvedValue(false);
      const first = render(ui());
      const input = await screen.findByRole("textbox");
      expect(input).toHaveValue("Verify this goal");
      expect(input).toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.anything(),
          "/goal start Verify this goal",
        ),
      );
      // Rejected sends retain intent for a retry even across a full reload.
      first.unmount();
      mockOnSubmit.mockResolvedValue(true);
      const second = render(ui());
      const restored = await screen.findByRole("textbox");
      expect(restored).toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      fireEvent.keyDown(restored, { key: "Enter" });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Exit goal mode" }),
        ).not.toBeInTheDocument(),
      );
      second.unmount();
      render(ui());
      expect(await screen.findByRole("textbox")).not.toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
    },
  );

  it("keeps restored goal intent through entitlement and flag loading without sending a normal request", async () => {
    jest.mocked(useAuth).mockReturnValue({
      user: { id: "goal-loading-user" },
      entitlements: [],
    } as ReturnType<typeof useAuth>);
    mockSandboxState = {
      chatMode: "ask",
      subscription: "free",
      isCheckingProPlan: true,
      chatModeAccessResolved: false,
    };
    let resolveGoal: (value: unknown) => void = () => {};
    const goalResponse = new Promise((resolve) => {
      resolveGoal = resolve;
    });
    mockFetch.mockImplementation((url) =>
      url === "/api/agent-goal"
        ? goalResponse
        : Promise.resolve({
            ok: true,
            json: async () => ({ assignment: null }),
          }),
    );
    window.localStorage.setItem(
      CONVERSATION_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        drafts: [
          {
            id: "loading-goal",
            content: "Keep my goal",
            goalMode: true,
            timestamp: Date.now(),
          },
        ],
      }),
    );
    const ui = () => (
      <TestWrapper>
        <ChatInput
          chatId="loading-goal"
          onSubmit={mockOnSubmit}
          status="ready"
        />
      </TestWrapper>
    );
    const { rerender } = render(ui());
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    expect(mockOnSubmit).not.toHaveBeenCalled();
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
      chatModeAccessResolved: true,
    };
    rerender(ui());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mockOnSubmit).not.toHaveBeenCalled();
    await act(async () => {
      resolveGoal({ ok: true, json: async () => ({ enabled: true }) });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Describe your goal, define measurable outcomes for best results",
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.anything(),
        "/goal start Keep my goal",
      ),
    );
  });

  it("clears accepted goal intent while preserving text typed during submission", async () => {
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
      chatModeAccessResolved: true,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    window.localStorage.setItem(
      CONVERSATION_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        drafts: [
          {
            id: "new",
            content: "First goal",
            goalMode: true,
            timestamp: Date.now(),
          },
        ],
      }),
    );
    let accept: (value: boolean) => void = () => {};
    mockOnSubmit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const ui = () => (
      <TestWrapper>
        <ChatInput isNewChat onSubmit={mockOnSubmit} status="ready" />
      </TestWrapper>
    );
    const first = render(ui());
    const input = await screen.findByRole("textbox");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.anything(),
        "/goal start First goal",
      ),
    );
    fireEvent.change(input, { target: { value: "Next ordinary request" } });
    await act(async () => {
      accept(true);
    });
    expect(input).toHaveValue("Next ordinary request");
    expect(
      screen.queryByRole("button", { name: "Exit goal mode" }),
    ).not.toBeInTheDocument();
    first.unmount();
    render(ui());
    expect(await screen.findByRole("textbox")).toHaveValue(
      "Next ordinary request",
    );
    expect(
      screen.queryByRole("button", { name: "Exit goal mode" }),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "cleans only the unchanged admitted draft after leaving the composer (newerDraft=%s)",
    async (newerDraft) => {
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      });
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "departing-goal",
              content: "Original goal",
              goalMode: true,
              timestamp: Date.now(),
            },
          ],
        }),
      );
      let accept!: (value: boolean) => void;
      mockOnSubmit.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            accept = resolve;
          }),
      );
      const view = render(
        <TestWrapper>
          <ChatInput
            chatId="departing-goal"
            onSubmit={mockOnSubmit}
            status="ready"
          />
        </TestWrapper>,
      );
      const input = await screen.findByRole("textbox");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
      view.unmount();
      if (newerDraft) upsertDraft("departing-goal", "Newer goal draft");
      await act(async () => {
        accept(true);
      });
      expect(getDraftContentById("departing-goal")).toBe(
        newerDraft ? "Newer goal draft" : null,
      );
    },
  );

  it("clears an admitted prompt when navigation replaced an empty attachment list", async () => {
    let accept!: (value: boolean) => void;
    mockOnSubmit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    render(
      <TestWrapper>
        <UploadedFilesSetter files={[]} label="Reset empty attachments" />
        <ChatInput
          chatId="empty-files-goal"
          onSubmit={mockOnSubmit}
          status="ready"
        />
      </TestWrapper>,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Accepted prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: "Reset empty attachments" }),
    );
    await act(async () => {
      accept(true);
    });
    expect(input).toHaveValue("");
  });

  describe("goal composer analytics", () => {
    afterEach(() => jest.restoreAllMocks());

    it.each([
      "accepted",
      "refused",
      "error",
      "unconfirmed",
      "canceled",
      "unmounted",
    ] as const)(
      "records %s separately without leaking the objective",
      async (outcome) => {
        jest.spyOn(toast, "info").mockReturnValue(0);
        jest.spyOn(toast, "error").mockReturnValue(0);
        const capture = mockGoalCapture;
        jest.mocked(useAuth).mockReturnValue({
          user: { id: "goal-analytics-user" },
          entitlements: [],
        } as ReturnType<typeof useAuth>);
        mockSandboxState = {
          chatMode: "agent",
          subscription: "pro",
          isCheckingProPlan: false,
        };
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ enabled: true }),
        });
        if (outcome === "unconfirmed")
          mockOnSubmit.mockRejectedValue(
            new GoalSubmissionUnconfirmedError(true),
          );
        else if (outcome === "canceled")
          mockOnSubmit.mockRejectedValue(
            new DOMException("Stopped", "AbortError"),
          );
        else if (outcome === "error")
          mockOnSubmit.mockRejectedValue(new Error("PRIVATE_ERROR_TEXT"));
        else mockOnSubmit.mockResolvedValue(outcome === "accepted");
        let rejectLate!: (error: Error) => void;
        if (outcome === "unmounted")
          mockOnSubmit.mockImplementation(
            () =>
              new Promise((_resolve, reject) => {
                rejectLate = reject;
              }),
          );
        const view = render(
          <TestWrapper>
            <ChatInput onSubmit={mockOnSubmit} status="ready" />
          </TestWrapper>,
        );
        const input = await screen.findByRole("textbox");
        fireEvent.change(input, { target: { value: "PRIVATE_OBJECTIVE" } });
        fireEvent.keyDown(
          await screen.findByRole("button", {
            name: "Add files or pursue a goal",
          }),
          { key: "Enter" },
        );
        fireEvent.click(
          await screen.findByRole("menuitem", { name: "Pursue goal" }),
        );
        fireEvent.keyDown(input, { key: "Enter" });
        if (outcome === "unmounted") {
          await waitFor(() => expect(mockOnSubmit).toHaveBeenCalled());
          view.unmount();
          await act(async () =>
            rejectLate(
              new GoalSubmissionUnconfirmedError(true, "originating-chat"),
            ),
          );
        }
        const reportedOutcome =
          outcome === "unmounted" ? "unconfirmed" : outcome;
        await waitFor(() =>
          expect(capture).toHaveBeenCalledWith(
            "agent_goal_composer_action",
            expect.objectContaining({
              action: `submit_${reportedOutcome}`,
              composer_layout: "desktop",
            }),
          ),
        );
        const goalEvents = capture.mock.calls.filter(
          ([name]) => name === "agent_goal_composer_action",
        );
        expect(goalEvents.map(([, properties]) => properties.action)).toEqual([
          "submit_attempt",
          `submit_${reportedOutcome}`,
        ]);
        expect(JSON.stringify(capture.mock.calls)).not.toContain(
          "PRIVATE_OBJECTIVE",
        );
        expect(JSON.stringify(capture.mock.calls)).not.toContain(
          "PRIVATE_ERROR_TEXT",
        );
        if (reportedOutcome === "unconfirmed") {
          expect(toast.info).toHaveBeenCalledWith(
            expect.stringContaining("Your draft is kept."),
            expect.any(Object),
          );
          expect(toast.error).not.toHaveBeenCalled();
        }
        if (outcome === "canceled") expect(toast.error).not.toHaveBeenCalled();
        if (outcome !== "accepted" && outcome !== "unmounted") {
          expect(input).toHaveValue("PRIVATE_OBJECTIVE");
          expect(
            screen.getByRole("button", { name: "Exit goal mode" }),
          ).toBeVisible();
          fireEvent.click(
            screen.getByRole("button", { name: "Exit goal mode" }),
          );
          expect(capture).toHaveBeenLastCalledWith(
            "agent_goal_composer_action",
            expect.objectContaining({ action: "exit", reason: "close_button" }),
          );
          expect(input).toHaveValue("PRIVATE_OBJECTIVE");
        }
      },
    );
  });

  it.each([false, true])(
    "selects a goal from the add menu without losing draft or attachments (mobile=%s)",
    async (mobile) => {
      mockIsMobile = mobile;
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "goal-menu-user" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      });
      mockOnSubmit.mockResolvedValue(true);
      const file: UploadedFileState = {
        file: new File(["fixture"], "goal-context.txt", { type: "text/plain" }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "goal-context",
      };
      render(
        <TestWrapper>
          <UploadedFilesSetter files={[file]} label="Attach context" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Attach context" }));
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, {
        target: { value: "Verify the attached file" },
      });
      const add = await screen.findByRole("button", {
        name: "Add files or pursue a goal",
      });
      fireEvent.keyDown(add, { key: "Enter" });
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /^Pursue goal/ }),
      );
      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveValue("Verify the attached file");
      expect(input).toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
      expect(screen.getByText("goal-context.txt")).toBeVisible();
      expect(mockOnSubmit).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.anything(),
          "/goal start Verify the attached file",
        ),
      );
    },
  );

  it.each([
    { mobile: false, subscription: "free", chatMode: "agent", enabled: true },
    { mobile: false, subscription: "pro", chatMode: "ask", enabled: true },
    { mobile: false, subscription: "pro", chatMode: "agent", enabled: false },
    { mobile: true, subscription: "free", chatMode: "agent", enabled: true },
    { mobile: true, subscription: "pro", chatMode: "ask", enabled: true },
    { mobile: true, subscription: "pro", chatMode: "agent", enabled: false },
  ] as const)(
    "keeps the existing attachment action outside eligible Agent: %j",
    async ({ mobile, subscription, chatMode, enabled }) => {
      mockIsMobile = mobile;
      jest.mocked(useAuth).mockReturnValue({
        user: { id: "goal-menu-user" },
        entitlements: [],
      } as ReturnType<typeof useAuth>);
      mockSandboxState = { subscription, chatMode, isCheckingProPlan: false };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled }),
      });
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );
      await act(async () => {});
      expect(
        screen.getByRole("button", { name: "Attach files" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Add files or pursue a goal" }),
      ).not.toBeInTheDocument();
    },
  );

  it("selects /goal without sending and submits its objective through goal mode", async () => {
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    mockOnSubmit.mockResolvedValue(true);
    render(
      <TestWrapper>
        <ChatInput
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          onSendNow={jest.fn()}
          status="ready"
        />
      </TestWrapper>,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "/goal" } });
    await screen.findByRole("button", {
      name: "Goal Set a goal to keep pursuing",
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOnSubmit).not.toHaveBeenCalled();
    expect(input).toHaveAttribute(
      "placeholder",
      "Describe your goal, define measurable outcomes for best results",
    );
    fireEvent.change(input, { target: { value: "Create a marker" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.anything(),
        "/goal start Create a marker",
      ),
    );
  });

  it.each([
    ["Create a marker /goal", "Create a marker", "Enter"],
    ["Create /goal a marker", "Create a marker", "Tab"],
    ["Create /GOAL a marker", "Create a marker", "click"],
    [
      "Create a marker\n/goal\nCriteria: Read it back",
      "Create a marker\n\nCriteria: Read it back",
      "Enter",
    ],
  ])(
    "selects an inline command in %s without losing draft content",
    async (draft, objective, selection) => {
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      });
      mockOnSubmit.mockResolvedValue(true);
      const file: UploadedFileState = {
        file: new File(["fixture"], "inline-goal.txt", { type: "text/plain" }),
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "inline-goal-file",
      };
      render(
        <TestWrapper>
          <UploadedFilesSetter files={[file]} label="Attach inline context" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onSendNow={jest.fn()}
            status="ready"
          />
        </TestWrapper>,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Attach inline context" }),
      );
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, { target: { value: draft } });
      const suggestion = await screen.findByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      });
      if (selection === "click") fireEvent.click(suggestion);
      else fireEvent.keyDown(input, { key: selection });
      expect(mockOnSubmit).not.toHaveBeenCalled();
      expect(input).toHaveValue(objective);
      expect(screen.getByText("inline-goal.txt")).toBeVisible();
      expect(input).toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.anything(),
          `/goal start ${objective}`,
        ),
      );
    },
  );

  it("sends mid-draft partial commands unchanged instead of selecting goal mode", async () => {
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    mockOnSubmit.mockResolvedValue(false);
    render(
      <TestWrapper>
        <ChatInput onSubmit={mockOnSubmit} onStop={mockOnStop} status="ready" />
      </TestWrapper>,
    );
    const input = await screen.findByRole("textbox");
    // Wait for the feature decision, then replace a valid suggestion with normal text.
    fireEvent.change(input, { target: { value: "/goal" } });
    await screen.findByRole("button", {
      name: "Goal Set a goal to keep pursuing",
    });
    fireEvent.change(input, {
      target: { value: "Search for /go in this path" },
    });
    expect(
      screen.queryByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(expect.anything(), undefined),
    );
    expect(input).toHaveValue("Search for /go in this path");
  });

  it("dismisses an inline goal suggestion without changing the draft", async () => {
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    render(
      <TestWrapper>
        <ChatInput
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          onSendNow={jest.fn()}
          status="ready"
        />
      </TestWrapper>,
    );
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Explain /goal" } });
    await screen.findByRole("button", {
      name: "Goal Set a goal to keep pursuing",
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    ).not.toBeInTheDocument();
    expect(input).toHaveValue("Explain /goal");
    // A committed edit revokes the dismissal, even if a later edit restores
    // exactly the text that was previously dismissed.
    fireEvent.change(input, { target: { value: "Explain more /goal" } });
    expect(
      screen.getByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "Explain /goal" } });
    expect(
      screen.getByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    ).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(expect.anything(), undefined),
    );
  });

  it.each(["chat", "ask", "free"])(
    "ignores a late availability response after changing %s",
    async (change) => {
      mockSandboxState = {
        chatMode: "agent",
        subscription: "pro",
        isCheckingProPlan: false,
      };
      let resolveAvailability!: (value: { enabled: boolean }) => void;
      const availability = new Promise<{ enabled: boolean }>((resolve) => {
        resolveAvailability = resolve;
      });
      const readAvailability = jest.fn(() => availability);
      mockFetch.mockResolvedValueOnce({ ok: true, json: readAvailability });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: false }),
      });
      const ui = (chatId: string) => (
        <TestWrapper>
          <ChatInput
            chatId={chatId}
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onSendNow={jest.fn()}
            status="ready"
          />
        </TestWrapper>
      );
      const { rerender } = render(ui("first-chat"));
      await waitFor(() => expect(readAvailability).toHaveBeenCalled());
      if (change === "ask")
        mockSandboxState = { ...mockSandboxState, chatMode: "ask" };
      if (change === "free")
        mockSandboxState = { ...mockSandboxState, subscription: "free" };
      rerender(ui(change === "chat" ? "second-chat" : "first-chat"));
      await act(async () => resolveAvailability({ enabled: true }));
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Create a marker /goal" },
      });
      expect(
        screen.queryByRole("button", {
          name: "Goal Set a goal to keep pursuing",
        }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).not.toHaveAttribute(
        "placeholder",
        "Describe your goal, define measurable outcomes for best results",
      );
    },
  );

  it("waits for attachment removal before accepting a message", async () => {
    const attachment: UploadedFileState = {
      file: new File(["fixture"], "removing.txt", { type: "text/plain" }),
      uploading: false,
      uploaded: true,
      storage: "s3",
      fileId: "removing-file",
    };
    render(
      <TestWrapper>
        <UploadedFilesSetter
          files={[{ ...attachment, removing: true }]}
          label="Removal pending"
        />
        <UploadedFilesSetter files={[attachment]} label="Removal failed" />
        <ChatInput
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          onSendNow={jest.fn()}
          status="ready"
        />
      </TestWrapper>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Removal pending" }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOnSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Removal failed" }));
    expect(input).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
  });

  it("keeps goal intent when a responsive layout remounts the same draft", async () => {
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    const ui = (placement: string, chatId: string) => (
      <TestWrapper>
        <ChatInput
          key={placement}
          chatId={chatId}
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          onSendNow={jest.fn()}
          status="ready"
        />
      </TestWrapper>
    );
    const { rerender } = render(ui("mobile", "goal-draft"));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "/goal" },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    );
    rerender(ui("desktop", "goal-draft"));
    expect(
      screen.getByRole("button", { name: "Exit goal mode" }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Verify the attachment" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.anything(),
        "/goal start Verify the attachment",
      ),
    );
    rerender(ui("desktop", "another-draft"));
    expect(
      screen.queryByRole("button", { name: "Exit goal mode" }),
    ).not.toBeInTheDocument();
  });

  it("preserves a goal draft and attachment while an approval replaces the composer", async () => {
    jest.mocked(useAuth).mockReturnValue({
      user: { id: "user_123" },
      entitlements: [],
    } as ReturnType<typeof useAuth>);
    mockSandboxState = {
      chatMode: "agent",
      subscription: "pro",
      isCheckingProPlan: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    });
    const file: UploadedFileState = {
      file: new File(["Goal attachment fixture"], "goal-context.txt", {
        type: "text/plain",
      }),
      uploading: false,
      uploaded: true,
      storage: "s3",
      fileId: "goal-context-file",
    };
    const approval = {
      approvalId: "goal-approval",
      toolCallId: "goal-tool",
      title: "Allow this local check?",
      target: "pwd",
      detail: "Approve to continue.",
      kind: "terminal" as const,
      operation: "terminal_execute",
    };
    const ui = (pending: boolean) => (
      <TestWrapper>
        <UploadedFilesSetter files={[file]} label="Attach goal context" />
        <ChatInput
          onSubmit={mockOnSubmit}
          onStop={mockOnStop}
          status="ready"
          chatId="goal-approval-chat"
          onSendNow={jest.fn()}
          storedApprovalRequest={pending ? approval : null}
        />
      </TestWrapper>
    );
    const { rerender } = render(ui(false));
    fireEvent.click(
      screen.getByRole("button", { name: "Attach goal context" }),
    );
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "/goal" },
    });
    await screen.findByRole("button", {
      name: "Goal Set a goal to keep pursuing",
    });
    expect(screen.getByText("goal-context.txt")).toBeVisible();

    rerender(ui(true));
    expect(screen.getByTestId("agent-approval-prompt")).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Goal Set a goal to keep pursuing",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("goal-context.txt")).not.toBeInTheDocument();

    rerender(ui(false));
    expect(await screen.findByRole("textbox")).toHaveValue("/goal");
    expect(screen.getByText("goal-context.txt")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Goal Set a goal to keep pursuing" }),
    );
    expect(
      screen.getByRole("button", { name: "Exit goal mode" }),
    ).toBeVisible();
    expect(screen.getByText("goal-context.txt")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });
});
