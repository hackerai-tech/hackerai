import "@testing-library/jest-dom";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { ConvexError } from "convex/values";
import { GoalSubmissionUnconfirmedError } from "@/lib/chat/goal-submission";
import { toast } from "sonner";

jest.mock("uuid", () => ({
  v4: () => "queued-message-id",
}));

// ===== IMPORTANT: Mock all dependencies BEFORE importing Chat =====
// These mocks are hoisted by Jest

// Mock @ai-sdk/react
const mockSendMessage = jest
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const mockSetMessages = jest.fn();
const mockStop = jest.fn();
const mockClearError = jest.fn();
const mockHandleSubmit = jest.fn();
const mockRegenerate = jest.fn();
const mockResumeStream = jest.fn();
const mockFetchAgentLongStream =
  jest.fn<
    typeof import("@/lib/chat/agent-long-transport").fetchAgentLongStream
  >();
const mockResumeAgentLongStream =
  jest.fn<
    typeof import("@/lib/chat/agent-long-transport").resumeAgentLongStream
  >();
jest.mock("@/lib/chat/agent-long-transport", () => ({
  ...jest.requireActual<typeof import("@/lib/chat/agent-long-transport")>(
    "@/lib/chat/agent-long-transport",
  ),
  fetchAgentLongStream: (
    ...args: Parameters<typeof mockFetchAgentLongStream>
  ) => mockFetchAgentLongStream(...args),
  resumeAgentLongStream: (
    ...args: Parameters<typeof mockResumeAgentLongStream>
  ) => mockResumeAgentLongStream(...args),
}));
let mockRouteParams: Record<string, string> = {};
const mockBranchChat = jest.fn<() => Promise<string | null>>();
const mockRouterPush = jest.fn();
let mockComputerOverlayMedia = false;
const mockOverlayListeners = new Set<() => void>();
const originalMatchMedia = window.matchMedia;

let mockUseRealChatHandlers = false;
let mockSavedGoal: Record<string, unknown> | undefined;
let mockLocalConnections:
  Array<{ connectionId: string; isDesktop: boolean }> | undefined;
let mockChatHandlerArgs: Parameters<
  typeof import("@/app/hooks/useChatHandlers").useChatHandlers
>[0];
let mockRestoredChat:
  | {
      id: string;
      sandbox_type?: string;
      default_model_slug: string;
      finish_reason?: string;
      active_stream_id?: string;
      active_trigger_run_id?: string;
      active_agent_user_wait?: {
        runId: string;
        toolCallId: string;
        status: "waiting";
        questions?: import("@/lib/chat/user-input-questions").UserInputQuestion[];
      };
    }
  | undefined;
let mockDesktopState: Partial<
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
      ...mockDesktopState,
    }),
  };
});
jest.mock("convex/react", () => {
  const original =
    jest.requireActual<typeof import("convex/react")>("convex/react");
  return {
    ...original,
    useMutation: (mutation: any) => {
      const { getFunctionName } = require("convex/server");
      return getFunctionName(mutation) === "messages:branchChat"
        ? mockBranchChat
        : original.useMutation(mutation);
    },
    useQuery: (query: any, ...args: any[]) => {
      const { getFunctionName } = require("convex/server");
      if (getFunctionName(query) === "agentGoals:get") return mockSavedGoal;
      if (getFunctionName(query) === "localSandbox:listConnections")
        return mockLocalConnections;
      return getFunctionName(query) === "chats:getChatByIdFromClient" &&
        mockRestoredChat
        ? mockRestoredChat
        : original.useQuery(query, ...args);
    },
  };
});

jest.mock("@ai-sdk/react", () => ({
  useChat: jest.fn(() => ({
    messages: [],
    sendMessage: mockSendMessage,
    setMessages: mockSetMessages,
    status: "ready",
    stop: mockStop,
    error: null,
    regenerate: mockRegenerate,
    resumeStream: mockResumeStream,
  })),
}));

jest.mock("next/navigation", () => ({
  useParams: jest.fn(() => mockRouteParams),
  usePathname: jest.fn(() =>
    mockRouteParams.id ? `/c/${mockRouteParams.id}` : "/",
  ),
  useRouter: jest.fn(() => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  })),
}));

jest.mock("react-hotkeys-hook", () => ({
  useHotkeys: jest.fn(),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: jest.fn(() => false),
}));

jest.mock("@/lib/utils/client-storage", () => ({
  ...jest.requireActual<typeof import("@/lib/utils/client-storage")>(
    "@/lib/utils/client-storage",
  ),
  NULL_THREAD_DRAFT_ID: "null-thread",
  getDraftContentById: jest.fn(() => null),
  getDraftAttachmentsById: jest.fn(() => []),
  hasDraftAttachmentsById: jest.fn(() => false),
  upsertDraft: jest.fn(),
  upsertDraftAttachments: jest.fn(),
  removeDraftAttachments: jest.fn(),
  removeDraft: jest.fn(),
}));

jest.mock("../../hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileInputRef: { current: null },
    handleFileUploadEvent: jest.fn(),
    handleRemoveFile: jest.fn(),
    handleAttachClick: jest.fn(),
    handlePasteEvent: jest.fn(),
    handlePastedTextAttachment: jest.fn(),
    isDragOver: false,
    showDragOverlay: false,
    handleDragEnter: jest.fn(),
    handleDragLeave: jest.fn(),
    handleDragOver: jest.fn(),
    handleDrop: jest.fn(),
  }),
}));

jest.mock("../../hooks/useDocumentDragAndDrop", () => ({
  useDocumentDragAndDrop: () => {},
}));

jest.mock("../../hooks/useChats", () => ({
  useChats: () => ({
    results: [],
    status: "Exhausted",
    loadMore: jest.fn(),
  }),
}));

jest.mock("../../hooks/useChatHandlers", () => ({
  useChatHandlers: (args: typeof mockChatHandlerArgs) => {
    mockChatHandlerArgs = args;
    if (mockUseRealChatHandlers) {
      return jest
        .requireActual<typeof import("@/app/hooks/useChatHandlers")>(
          "@/app/hooks/useChatHandlers",
        )
        .useChatHandlers(args);
    }
    return {
      handleSubmit: mockHandleSubmit,
      handleStop: jest.fn(),
      handleRegenerate: jest.fn(),
      handleRetry: jest.fn(),
      handleEditMessage: jest.fn(),
    };
  },
}));

let mockIsAtBottom = true;
const mockScrollToBottom = jest.fn();
jest.mock("../../hooks/useMessageScroll", () => ({
  useMessageScroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    scrollToBottom: mockScrollToBottom,
    isAtBottom: mockIsAtBottom,
  }),
}));

jest.mock("../../hooks/useAutoResume", () => ({
  useAutoResume: jest.fn(),
}));

jest.mock("../SidebarHeader", () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar-header">Sidebar Header</div>,
}));

jest.mock("../SidebarUserNav", () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar-user-nav">User Nav</div>,
}));

jest.mock("../SidebarHistory", () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar-history">Sidebar History</div>,
}));

jest.mock("../MemoizedMarkdown", () => ({
  MemoizedMarkdown: ({ children }: any) => (
    <div data-testid="memoized-markdown">{children}</div>
  ),
}));

jest.mock("../Messages", () => ({
  Messages: ({ messages, onBranchMessage }: any) => (
    <div data-testid="messages-component">
      {messages.length} messages
      <button type="button" onClick={() => onBranchMessage("assistant-1")}>
        Branch message
      </button>
    </div>
  ),
}));

let mockChatInputProps: Parameters<typeof import("../ChatInput").ChatInput>[0];
jest.mock("../ChatInput", () => ({
  ChatInput: (props: typeof mockChatInputProps) => {
    mockChatInputProps = props;
    const { onSubmit, goalPanel } = props;
    return (
      <div data-testid="chat-input">
        ChatInput{goalPanel?.("attached")}
        <textarea aria-label="Test draft" />
        <button onClick={() => onSubmit({ preventDefault: jest.fn() })}>
          Submit test message
        </button>
      </div>
    );
  },
}));

let mockContinueGoal: NonNullable<
  Parameters<
    typeof import("../ComputerSidebar").ComputerSidebar
  >[0]["continueGoal"]
>;
let mockBrowserContinue: (message: {
  id: string;
  text: string;
}) => Promise<void>;
jest.mock("../ComputerSidebar", () => ({
  ComputerSidebar: ({
    onBrowserContinue,
    continueGoal,
  }: {
    onBrowserContinue: typeof mockBrowserContinue;
    continueGoal: typeof mockContinueGoal;
  }) => {
    mockBrowserContinue = onBrowserContinue;
    mockContinueGoal = continueGoal;
    const [draft, setDraft] = useState("");
    return (
      <div data-testid="computer-sidebar">
        Sidebar
        <button type="button">First computer action</button>
        <textarea
          aria-label="Computer draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button">Last computer action</button>
        <input aria-label="Hidden computer field" hidden />
        <details>
          <summary>More computer actions</summary>
          <input aria-label="Collapsed computer field" />
        </details>
      </div>
    );
  },
}));

jest.mock("../ChatHeader", () => ({
  __esModule: true,
  default: () => <div data-testid="chat-header">Chat Header</div>,
}));

jest.mock("../Sidebar", () => ({
  __esModule: true,
  default: () => <div data-testid="main-sidebar">Main Sidebar</div>,
}));

jest.mock("../Footer", () => ({
  __esModule: true,
  default: () => <div data-testid="footer">Footer</div>,
}));

jest.mock("../DragDropOverlay", () => ({
  DragDropOverlay: ({ isVisible }: any) =>
    isVisible ? <div data-testid="drag-overlay">Drag Overlay</div> : null,
}));

jest.mock("../ConvexErrorBoundary", () => ({
  ConvexErrorBoundary: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: any) => <div>{children}</div>,
}));

// ===== NOW import components =====
const {
  Chat,
  getExistingChatLoadState,
  getStoredAgentApprovalRequest,
  useStreamedChatTitle,
  useServerMessages,
} = jest.requireActual<typeof import("../chat")>("../chat");
const { ChatLayout } =
  jest.requireActual<typeof import("../ChatLayout")>("../ChatLayout");
const { TestWrapper } =
  jest.requireActual<typeof import("../testUtils")>("../testUtils");
const { useGlobalState } = jest.requireActual<
  typeof import("@/app/contexts/GlobalState")
>("@/app/contexts/GlobalState");

const { useComposerActions, useComposerInput } = jest.requireActual<
  typeof import("@/app/contexts/ComposerState")
>("@/app/contexts/ComposerState");
const mockUseAuth = require("@workos-inc/authkit-nextjs/components").useAuth;
const defaultAuth = mockUseAuth();
const originalFetch = global.fetch;
const ForkDraftSetter = () => {
  const { setInput } = useComposerActions();
  useEffect(() => setInput("continue"), [setInput]);
  return null;
};
const RecoveryDraftProbe = () => (
  <output data-testid="recovery-draft">{useComposerInput()}</output>
);
const RecoveryComputerPicker = () => {
  const { setSandboxPreference } = useGlobalState();
  return (
    <>
      <button onClick={() => setSandboxPreference("desktop")}>
        Use Local QA
      </button>
      <button onClick={() => setSandboxPreference("e2b")}>Use Cloud QA</button>
    </>
  );
};
const RecoveryQueueProbe = () => {
  const { queueMessage, messageQueue } = useGlobalState();
  return (
    <>
      <button onClick={() => queueMessage("queued after recovery")}>
        Queue recovery draft
      </button>
      <output data-testid="recovery-queue">{messageQueue.length}</output>
    </>
  );
};

const SelectedComputerProbe = () => {
  const { sandboxPreference, initializeNewChat } = useGlobalState();
  return (
    <>
      <output data-testid="selected-computer">{sandboxPreference}</output>
      <button onClick={initializeNewChat}>Start fresh chat</button>
    </>
  );
};

const ComputerSelectionHistory = ({ selections }: { selections: string[] }) => {
  const { sandboxPreference } = useGlobalState();
  useEffect(() => {
    selections.push(sandboxPreference);
  }, [sandboxPreference, selections]);
  return <SelectedComputerProbe />;
};

const DisconnectedQueueHarness = () => {
  const { setChatMode, setSandboxPreference, queueMessage, messageQueue } =
    useGlobalState();
  useEffect(() => {
    setChatMode("agent");
    setSandboxPreference("desktop");
  }, [setChatMode, setSandboxPreference]);
  return (
    <>
      <button onClick={() => queueMessage("continue")}>Queue continue</button>
      <output data-testid="pending-queue">{messageQueue.length}</output>
    </>
  );
};

const QueueEditingHarness = ({
  mode = "agent",
}: {
  mode?: "agent" | "ask";
}) => {
  const {
    messageQueue,
    queueMessage,
    setChatMode,
    updateQueuedMessage,
    setEditingQueuedMessageId,
  } = useGlobalState();
  const hasSetActualEditingId = useRef(false);

  useEffect(() => {
    setChatMode(mode);
    queueMessage("original queued message");
    setEditingQueuedMessageId("queued-message-id");
  }, [queueMessage, setEditingQueuedMessageId, setChatMode, mode]);

  useEffect(() => {
    if (messageQueue[0] && !hasSetActualEditingId.current) {
      hasSetActualEditingId.current = true;
      setEditingQueuedMessageId(messageQueue[0].id);
    }
  }, [messageQueue, setEditingQueuedMessageId]);

  const saveEdit = () => {
    const queuedMessage = messageQueue[0];
    if (!queuedMessage) return;

    updateQueuedMessage(queuedMessage.id, "updated queued message");
    setEditingQueuedMessageId(null);
  };

  return (
    <>
      <div data-testid="queue-state">Queued: {messageQueue.length}</div>
      <button type="button" onClick={saveEdit}>
        Save queued edit
      </button>
    </>
  );
};

const ChatTitleHandoffHarness = ({
  persistedTitle,
}: {
  persistedTitle: string;
}) => {
  const [chatTitle, setStreamedTitle] = useStreamedChatTitle(persistedTitle);

  return (
    <>
      <div data-testid="chat-title">{chatTitle}</div>
      <button type="button" onClick={() => setStreamedTitle("Generated title")}>
        Stream generated title
      </button>
    </>
  );
};

const OpenComputerSidebarHarness = () => {
  const { openSidebar, sidebarOpen } = useGlobalState();

  return (
    <>
      <span data-testid="computer-open-state">
        {sidebarOpen ? "open" : "closed"}
      </span>
      <button
        type="button"
        onClick={() =>
          openSidebar({
            command: "echo ready",
            output: "ready",
            isExecuting: false,
            toolCallId: "responsive-layout-test",
          })
        }
      >
        Open Computer
      </button>
    </>
  );
};

describe("Chat Component Integration", () => {
  let mockUseChat: jest.Mock;

  afterAll(() => {
    window.matchMedia = originalMatchMedia;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    require("@/hooks/use-mobile").useIsMobile.mockReturnValue(false);
    mockBranchChat.mockReset();
    mockUseAuth.mockReturnValue(defaultAuth);
    global.fetch = originalFetch;
    const convexReact = require("convex/react");
    convexReact.resetMockConvexAuth?.();
    convexReact.resetMockConvexQueries?.();
    mockRouteParams = {};
    mockRestoredChat = undefined;
    mockDesktopState = {};
    mockIsAtBottom = true;
    mockLocalConnections = undefined;
    mockUseRealChatHandlers = false;
    mockSavedGoal = undefined;
    window.localStorage.clear();
    mockComputerOverlayMedia = false;
    mockOverlayListeners.clear();
    window.matchMedia = jest.fn(
      (query: string) =>
        ({
          get matches() {
            return query === "(max-width: 949px)" && mockComputerOverlayMedia;
          },
          media: query,
          onchange: null,
          addEventListener: jest.fn((_event: string, listener: () => void) => {
            if (query === "(max-width: 949px)")
              mockOverlayListeners.add(listener);
          }),
          removeEventListener: jest.fn(),
          addListener: jest.fn(),
          removeListener: jest.fn(),
          dispatchEvent: jest.fn(),
        }) as MediaQueryList,
    );
    const { useChat } = require("@ai-sdk/react");
    mockUseChat = useChat as jest.Mock;

    mockUseChat.mockReturnValue({
      messages: [],
      sendMessage: mockSendMessage,
      setMessages: mockSetMessages,
      clearError: mockClearError,
      status: "ready",
      stop: mockStop,
      error: null,
      regenerate: mockRegenerate,
      resumeStream: mockResumeStream,
    });
  });

  describe("Basic Rendering", () => {
    it("holds Cloud sends during recovery and keeps the draft for an explicit send after verification", async () => {
      jest.useFakeTimers();
      try {
        mockUseRealChatHandlers = true;
        mockDesktopState = {
          chatMode: "agent",
          sandboxPreference: "e2b",
          subscription: "pro",
        };
        global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovering", step: "backup_created" }),
        } as Response);
        render(
          <TestWrapper>
            <Chat autoResume={false} />
            <ForkDraftSetter />
            <RecoveryDraftProbe />
          </TestWrapper>,
        );
        await screen.findByText(/Saving the recovered environment/);
        fireEvent.click(
          screen.getByRole("button", { name: "Submit test message" }),
        );
        await act(async () => {});
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(screen.getByTestId("recovery-draft")).toHaveTextContent(
          "continue",
        );
        jest.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovered" }),
        } as Response);
        await act(async () => jest.advanceTimersByTimeAsync(5000));
        expect(screen.getByText(/Workspace ready/)).toBeVisible();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(screen.getByTestId("recovery-draft")).toHaveTextContent(
          "continue",
        );
        fireEvent.click(
          screen.getByRole("button", { name: "Submit test message" }),
        );
        await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId("recovery-draft")).toBeEmptyDOMElement();
      } finally {
        jest.useRealTimers();
      }
    });

    it("does not automatically release queued work when workspace recovery finishes", async () => {
      jest.useFakeTimers();
      try {
        mockUseRealChatHandlers = true;
        mockDesktopState = {
          chatMode: "agent",
          sandboxPreference: "e2b",
          subscription: "pro",
        };
        global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovering", step: "backup_created" }),
        } as Response);
        render(
          <TestWrapper>
            <Chat autoResume={false} />
            <RecoveryQueueProbe />
          </TestWrapper>,
        );
        await screen.findByText(/Saving the recovered environment/);
        fireEvent.click(
          screen.getByRole("button", { name: "Queue recovery draft" }),
        );
        jest.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovered" }),
        } as Response);
        await act(async () => jest.advanceTimersByTimeAsync(5000));
        expect(screen.getByText(/Workspace ready/)).toBeVisible();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(screen.getByTestId("recovery-queue")).toHaveTextContent("1");
      } finally {
        jest.useRealTimers();
      }
    });

    it("preserves a Local fork's pending send while its saved computer loads during Cloud recovery", async () => {
      mockDesktopState = {
        chatMode: "agent",
        subscription: "pro",
      };
      global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "recovering", step: "backup_created" }),
      } as Response);
      const view = () => (
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      await screen.findByText(/Saving the recovered environment/);
      mockRouteParams = { id: "local-fork" };
      sessionStorage.setItem("autoSendChatId", "local-fork");
      await act(async () => rerender(view()));
      expect(sessionStorage.getItem("autoSendChatId")).toBe("local-fork");
      mockRestoredChat = {
        id: "local-fork",
        sandbox_type: "desktop",
        default_model_slug: "agent",
      };
      await act(async () => rerender(view()));
      expect(sessionStorage.getItem("autoSendChatId")).toBe("local-fork");
      sessionStorage.removeItem("autoSendChatId");
    });

    it("requires a new explicit send when recovery finishes before a Cloud fork's computer loads", async () => {
      jest.useFakeTimers();
      try {
        mockUseRealChatHandlers = true;
        mockDesktopState = { chatMode: "agent", subscription: "pro" };
        mockRouteParams = { id: "cloud-fork" };
        sessionStorage.setItem("autoSendChatId", "cloud-fork");
        global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovering", step: "backup_created" }),
        } as Response);
        const view = () => (
          <TestWrapper>
            <ForkDraftSetter />
            <Chat autoResume={false} />
            <RecoveryDraftProbe />
          </TestWrapper>
        );
        const { rerender } = render(view());
        await screen.findByText(/Saving the recovered environment/);
        jest.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ status: "recovered" }),
        } as Response);
        await act(async () => jest.advanceTimersByTimeAsync(5000));
        mockRestoredChat = {
          id: "cloud-fork",
          sandbox_type: "e2b",
          default_model_slug: "agent",
        };
        mockUseChat.mockReturnValue({
          messages: [
            {
              id: "original",
              role: "user",
              parts: [{ type: "text", text: "original" }],
            },
          ],
          sendMessage: mockSendMessage,
          setMessages: mockSetMessages,
          status: "ready",
          stop: mockStop,
          error: null,
          regenerate: mockRegenerate,
          resumeStream: mockResumeStream,
        });
        await act(async () => rerender(view()));
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("autoSendChatId")).toBeNull();
        expect(screen.getByTestId("recovery-draft")).toHaveTextContent(
          "continue",
        );
      } finally {
        sessionStorage.removeItem("autoSendChatId");
        jest.useRealTimers();
      }
    });

    it("waits for fresh recovery status when switching back from Local to Cloud", async () => {
      mockUseRealChatHandlers = true;
      mockDesktopState = { chatMode: "agent", subscription: "pro" };
      global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "hidden" }),
      } as Response);
      render(
        <TestWrapper>
          <Chat autoResume={false} />
          <ForkDraftSetter />
          <RecoveryDraftProbe />
          <RecoveryComputerPicker />
        </TestWrapper>,
      );
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Use Local QA" }));
      let resolveStatus!: (value: Response) => void;
      jest.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStatus = resolve;
          }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Use Cloud QA" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Submit test message" }),
      );
      await act(async () => {});
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("recovery-draft")).toHaveTextContent(
        "continue",
      );
      await act(async () =>
        resolveStatus({
          ok: true,
          json: async () => ({ status: "hidden" }),
        } as Response),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Submit test message" }),
      );
      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("recovery-draft")).toBeEmptyDOMElement();
    });

    it("preserves live draft and focus across folding and the first message", () => {
      const view = () => (
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      const input = screen.getByRole("textbox", { name: "Test draft" });
      fireEvent.change(input, { target: { value: "Unsaved fold draft" } });
      input.focus();
      const { useIsMobile } = require("@/hooks/use-mobile");
      for (const mobile of [true, false, true]) {
        useIsMobile.mockReturnValue(mobile);
        rerender(view());
        expect(screen.getByRole("textbox", { name: "Test draft" })).toHaveValue(
          "Unsaved fold draft",
        );
        expect(input).toHaveFocus();
      }
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [
          {
            id: "first-message",
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          },
        ],
      });
      rerender(view());
      expect(screen.getByRole("textbox", { name: "Test draft" })).toHaveValue(
        "Unsaved fold draft",
      );
      expect(input).toHaveFocus();
    });

    it.each([
      [
        new ConvexError({ code: "BRANCH_HISTORY_TOO_LARGE" }),
        "This task is too large to branch at this message. Try branching from an earlier message. Your original task is unchanged.",
      ],
      [
        new ConvexError({ code: "UNAUTHORIZED", message: "private details" }),
        "Failed to branch task. Please try again.",
      ],
    ])(
      "shows safe branch guidance without navigating on failure (%#)",
      async (error, expected) => {
        const toastError = jest.spyOn(toast, "error");
        mockBranchChat.mockRejectedValueOnce(error);
        mockUseChat.mockReturnValue({
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [{ type: "text", text: "Answer" }],
            },
          ],
          sendMessage: mockSendMessage,
          setMessages: mockSetMessages,
          status: "ready",
          stop: mockStop,
        });
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Branch message" }));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith(expected));
        expect(mockBranchChat).toHaveBeenCalledTimes(1);
        expect(mockBranchChat).toHaveBeenCalledWith({
          messageId: "assistant-1",
        });
        expect(mockRouterPush).not.toHaveBeenCalled();
        expect(screen.getByTestId("messages-component")).toHaveTextContent(
          "1 messages",
        );
        toastError.mockRestore();
      },
    );

    it("still navigates to a successfully created branch", async () => {
      mockBranchChat.mockResolvedValueOnce("new-branch");
      mockUseChat.mockReturnValue({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "Answer" }],
          },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
      });
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Branch message" }));
      await waitFor(() =>
        expect(mockRouterPush).toHaveBeenCalledWith("/c/new-branch"),
      );
      expect(mockBranchChat).toHaveBeenCalledTimes(1);
    });

    it("releases a persisted streamed title so later manual renames stay visible", () => {
      const { rerender } = render(
        <ChatTitleHandoffHarness persistedTitle="Original prompt" />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Stream generated title" }),
      );
      expect(screen.getByTestId("chat-title")).toHaveTextContent(
        "Generated title",
      );

      rerender(<ChatTitleHandoffHarness persistedTitle="Generated title" />);
      expect(screen.getByTestId("chat-title")).toHaveTextContent(
        "Generated title",
      );

      rerender(<ChatTitleHandoffHarness persistedTitle="Renamed title" />);
      expect(screen.getByTestId("chat-title")).toHaveTextContent(
        "Renamed title",
      );
    });

    it("should render new chat with welcome message", () => {
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    });

    it.each(["desktop", "tauri", "missing-remote"])(
      "restores %s from a reopened task without waiting for connections or selecting Cloud",
      async (sandboxType) => {
        mockRouteParams = { id: "reopened-task" };
        mockRestoredChat = {
          id: "reopened-task",
          sandbox_type: sandboxType,
          default_model_slug: "agent",
        };
        render(
          <TestWrapper>
            <Chat autoResume={false} />
            <SelectedComputerProbe />
          </TestWrapper>,
        );
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            sandboxType === "tauri" ? "desktop" : sandboxType,
          ),
        );
      },
    );

    it.each([undefined, "", "e2b", "desktop", "tauri", "missing-remote"])(
      "restores a free Desktop task (%s) without a transient Cloud selection",
      async (sandboxType) => {
        window.localStorage.setItem("sandbox-preference", "desktop");
        mockDesktopState = {
          freeDesktopAgentOnlyActive: true,
          desktopBridgeActive: true,
          localConnections: [],
        };
        mockRouteParams = { id: "first-desktop-task" };
        mockRestoredChat = {
          id: "first-desktop-task",
          sandbox_type: "desktop",
          default_model_slug: "agent",
        };
        const selections: string[] = [];
        const ui = () => (
          <TestWrapper>
            <Chat autoResume={false} />
            <ComputerSelectionHistory selections={selections} />
          </TestWrapper>
        );
        const { rerender } = render(ui());
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            "desktop",
          ),
        );

        mockRouteParams = { id: "second-task" };
        mockRestoredChat = {
          id: "second-task",
          sandbox_type: sandboxType,
          default_model_slug: "agent",
        };
        rerender(ui());
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            sandboxType === "missing-remote" ? "missing-remote" : "desktop",
          ),
        );
        expect(selections).not.toContain("e2b");
        expect(localStorage.getItem("sandbox-preference")).toBe("desktop");
      },
    );

    it.each([undefined, "e2b", "desktop", "missing-remote"])(
      "restores free Desktop sandbox %s across pending connection discovery",
      async (sandboxType) => {
        window.localStorage.setItem("sandbox-preference", "desktop");
        mockDesktopState = {
          freeDesktopAgentOnlyActive: true,
          desktopBridgeActive: false,
          localConnections: undefined,
        };
        mockRouteParams = { id: "discovery-task" };
        mockRestoredChat = {
          id: "discovery-task",
          sandbox_type: sandboxType,
          default_model_slug: "agent",
        };
        const selections: string[] = [];
        const ui = () => (
          <TestWrapper>
            <Chat autoResume={false} />
            <ComputerSelectionHistory selections={selections} />
          </TestWrapper>
        );
        const { rerender } = render(ui());
        expect(screen.getByTestId("selected-computer")).toHaveTextContent(
          sandboxType === "missing-remote" ? "missing-remote" : "desktop",
        );

        mockDesktopState = {
          ...mockDesktopState,
          localConnections: [
            { connectionId: "available-remote", isDesktop: false },
          ],
        };
        rerender(ui());
        const expectedPreference =
          !sandboxType || sandboxType === "e2b"
            ? "available-remote"
            : sandboxType;
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            expectedPreference,
          ),
        );
        expect(selections).not.toContain("e2b");
        expect(localStorage.getItem("sandbox-preference")).toBe("desktop");
      },
    );

    it.each(["button", "route"])(
      "keeps the new-chat default after visiting Desktop and Cloud tasks (%s)",
      async (navigation) => {
        window.localStorage.setItem(
          "sandbox-preference",
          "my-default-computer",
        );
        mockLocalConnections = [];
        mockRouteParams = { id: "desktop-task" };
        mockRestoredChat = {
          id: "desktop-task",
          sandbox_type: "desktop",
          default_model_slug: "agent",
        };
        const ui = () => (
          <TestWrapper>
            <Chat autoResume={false} />
            <SelectedComputerProbe />
          </TestWrapper>
        );
        const { rerender } = render(ui());
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            "desktop",
          ),
        );
        expect(localStorage.getItem("sandbox-preference")).toBe(
          "my-default-computer",
        );
        mockRouteParams = { id: "cloud-task" };
        mockRestoredChat = {
          id: "cloud-task",
          sandbox_type: "e2b",
          default_model_slug: "agent",
        };
        rerender(ui());
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            "e2b",
          ),
        );
        expect(localStorage.getItem("sandbox-preference")).toBe(
          "my-default-computer",
        );
        if (navigation === "button")
          fireEvent.click(
            screen.getByRole("button", { name: "Start fresh chat" }),
          );
        else {
          mockRouteParams = {};
          mockRestoredChat = undefined;
          rerender(ui());
        }
        await waitFor(() =>
          expect(screen.getByTestId("selected-computer")).toHaveTextContent(
            "my-default-computer",
          ),
        );
        expect(mockSendMessage).not.toHaveBeenCalled();
      },
    );

    it("keeps the useChat message snapshot stable across unrelated renders", () => {
      const { result, rerender } = renderHook(() =>
        useServerMessages(undefined),
      );
      const firstMessages = result.current;
      expect(Array.isArray(firstMessages)).toBe(true);

      rerender();

      expect(result.current).toBe(firstMessages);
    });

    it("keeps an existing chat loading while Convex auth is still loading", () => {
      expect(
        getExistingChatLoadState({
          isExistingChat: true,
          hasMessages: false,
          isConvexAuthLoading: true,
          isConvexAuthenticated: false,
          shouldFetchMessages: false,
          chatData: null,
          paginationStatus: "Exhausted",
          hasPaginatedMessageResults: false,
          awaitingServerChat: false,
        }),
      ).toEqual({
        isInitialExistingChatLoad: true,
        isChatNotFound: false,
      });
    });

    it("keeps an existing chat loading while the first message page is loading", () => {
      expect(
        getExistingChatLoadState({
          isExistingChat: true,
          hasMessages: false,
          isConvexAuthLoading: false,
          isConvexAuthenticated: true,
          shouldFetchMessages: true,
          chatData: null,
          paginationStatus: "LoadingFirstPage",
          hasPaginatedMessageResults: false,
          awaitingServerChat: false,
        }),
      ).toEqual({
        isInitialExistingChatLoad: true,
        isChatNotFound: false,
      });
    });

    it("does not show not found when messages resolved before chat metadata recovers", () => {
      expect(
        getExistingChatLoadState({
          isExistingChat: true,
          hasMessages: false,
          isConvexAuthLoading: false,
          isConvexAuthenticated: true,
          shouldFetchMessages: true,
          chatData: null,
          paginationStatus: "Exhausted",
          hasPaginatedMessageResults: true,
          awaitingServerChat: false,
        }),
      ).toEqual({
        isInitialExistingChatLoad: false,
        isChatNotFound: false,
      });
    });

    it("shows chat not found after auth and messages resolve empty", () => {
      expect(
        getExistingChatLoadState({
          isExistingChat: true,
          hasMessages: false,
          isConvexAuthLoading: false,
          isConvexAuthenticated: true,
          shouldFetchMessages: true,
          chatData: null,
          paginationStatus: "Exhausted",
          hasPaginatedMessageResults: false,
          awaitingServerChat: false,
        }),
      ).toEqual({
        isInitialExistingChatLoad: false,
        isChatNotFound: true,
      });
    });

    it("derives a stored approval prompt from operation and target only", () => {
      expect(
        getStoredAgentApprovalRequest({
          active_agent_approval_pending: true,
          active_agent_approval_request: {
            approvalId: "approval-1",
            toolCallId: "tool-1",
            operation: "terminal_execute",
            target: "ping -c 4 hackerone.com",
            justification: "Check whether the target host is reachable.",
            prefixRule: ["ping", "-c", "4"],
            createdAt: 123,
            autoReview: {
              verdict: "ask_user",
              riskCategory: "scope_expansion",
              rationale: "The referenced script contents are not visible.",
              rolloutPhase: "enforce",
            },
          },
        }),
      ).toEqual({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        operation: "terminal_execute",
        title: "Allow HackerAI to run this terminal command?",
        target: "ping -c 4 hackerone.com",
        justification: "Check whether the target host is reachable.",
        prefixRule: ["ping", "-c", "4"],
        detail: "Approve to continue, or deny to stop this command.",
        kind: "terminal",
        createdAt: 123,
        autoReview: {
          verdict: "ask_user",
          riskCategory: "scope_expansion",
          rationale: "The referenced script contents are not visible.",
          rolloutPhase: "enforce",
        },
      });
    });

    it("drops a malformed stored Auto review summary", () => {
      expect(
        getStoredAgentApprovalRequest({
          active_agent_approval_pending: true,
          active_agent_approval_request: {
            approvalId: "approval-1",
            toolCallId: "tool-1",
            operation: "terminal_execute",
            autoReview: {
              verdict: "approve_everything",
              riskCategory: "routine",
              rationale: "Invalid verdict.",
              rolloutPhase: "enforce",
            },
          },
        })?.autoReview,
      ).toBeUndefined();
    });
  });

  it("preserves streamed question restrictions without resurrecting cleared waits", async () => {
    mockRouteParams = { id: "wait-chat" };
    mockLocalConnections = [];
    mockRestoredChat = {
      id: "wait-chat",
      sandbox_type: "desktop",
      default_model_slug: "agent",
      active_trigger_run_id: "run-wait",
    };
    const questions = [
      {
        id: "choice",
        header: "Choice",
        question: "Alpha?",
        options: [{ value: "alpha", label: "Alpha" }],
        allowCustomAnswer: false,
      },
    ];
    const part = {
      type: "tool-wait_for_user",
      toolCallId: "wait-1",
      state: "input-available",
      input: { questions } as Record<string, unknown>,
    };
    const stream = {
      ...mockUseChat(),
      status: "streaming",
      messages: [{ id: "response", role: "assistant", parts: [part] }],
    };
    mockUseChat.mockReturnValue(stream);
    const view = () => (
      <TestWrapper>
        <Chat autoResume={false} />
      </TestWrapper>
    );
    const { rerender } = render(view());
    expect(mockChatInputProps.pendingUserWait?.toolCallId).toBe("wait-1");
    expect(mockChatInputProps.pendingUserWait?.questions).toEqual(questions);
    expect(mockChatInputProps.pendingUserWait?.published).toBeUndefined();
    expect(mockChatHandlerArgs.sendDisabledReason).toBeTruthy();
    mockRestoredChat.active_agent_user_wait = {
      runId: "run-wait",
      toolCallId: "wait-1",
      status: "waiting",
      questions,
    };
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait?.published).toBe(true);
    expect(mockChatInputProps.pendingUserWait?.questions).toEqual(questions);
    expect(mockChatHandlerArgs.sendDisabledReason).toBeTruthy();
    delete mockRestoredChat.active_agent_user_wait;
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait).toBeUndefined();

    // A genuinely new tool call can still appear before its subscription.
    part.toolCallId = "wait-2";
    part.input = {};
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait?.toolCallId).toBe("wait-2");
    expect(mockChatInputProps.pendingUserWait?.questions).toBeUndefined();
    part.input = { questions: [{ ...questions[0], options: [] }] };
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait?.questions).toBeUndefined();
    mockChatHandlerArgs.hasManuallyStoppedRef.current = true;
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait).toBeUndefined();
    mockChatHandlerArgs.hasManuallyStoppedRef.current = false;
    mockUseChat.mockReturnValue({ ...stream, status: "ready" });
    await act(async () => rerender(view()));
    expect(mockChatInputProps.pendingUserWait).toBeUndefined();
  });

  it("waits for the saved chat mode before restoring predictions", async () => {
    mockRouteParams = { id: "restore-prediction-mode" };
    mockUseChat.mockReturnValue({
      ...mockUseChat(),
      messages: [
        {
          id: "answer",
          role: "assistant",
          parts: [{ type: "text", text: "Saved answer" }],
        },
      ],
    });
    const view = () => (
      <TestWrapper>
        <Chat autoResume={false} />
      </TestWrapper>
    );
    const { rerender } = render(view());
    expect(mockChatInputProps.predictionModeReady).toBe(false);
    mockRestoredChat = {
      id: "restore-prediction-mode",
      default_model_slug: "agent",
    };
    await act(async () => rerender(view()));
    expect(mockChatInputProps.predictionModeReady).toBe(true);
  });

  describe("Prediction completion ownership", () => {
    const userB = {
      id: "user-b",
      role: "user",
      parts: [{ type: "text", text: "Current task" }],
    };
    const answerB = {
      id: "answer-b",
      role: "assistant",
      parts: [{ type: "text", text: "Current answer" }],
    };
    const userA = { ...userB, id: "user-a" };
    const answerA = { ...answerB, id: "answer-a" };
    const mount = () => {
      mockRouteParams = { id: "chat-b" };
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [userB, answerB],
      });
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      const finish = () =>
        (
          mockUseChat.mock.calls.at(-1)![0] as {
            onFinish: (result: Record<string, unknown>) => void;
          }
        ).onFinish;
      act(() =>
        finish()({
          isAbort: false,
          isError: false,
          message: answerB,
          messages: [userB, answerB],
        }),
      );
      expect(mockChatInputProps.completedPredictionTurn).toEqual({
        chatId: "chat-b",
        messageId: "answer-b",
      });
      return finish;
    };
    it.each([
      { isAbort: true, isError: false },
      { isAbort: false, isError: true },
      { isAbort: false, isError: false },
    ])(
      "ignores a previous task's late finish in the latest callback: %j",
      (outcome) => {
        const finish = mount();
        act(() =>
          finish()({
            ...outcome,
            message: answerA,
            messages: [userA, answerA],
          }),
        );
        expect(mockChatInputProps.completedPredictionTurn).toEqual({
          chatId: "chat-b",
          messageId: "answer-b",
        });
        expect(mockChatInputProps.interruptedPredictionTurn).toBeNull();
      },
    );
    it.each([
      { isAbort: true, isError: false },
      { isAbort: false, isError: true },
    ])(
      "clears current-task lineage before the assistant exists when visible messages lag: %j",
      (outcome) => {
        const finish = mount();
        act(() =>
          finish()({
            ...outcome,
            message: { ...answerB, id: "not-appended" },
            messages: [userB, answerB, { ...userB, id: "new-user-b" }],
          }),
        );
        expect(mockChatInputProps.completedPredictionTurn).toBeNull();
        expect(mockChatInputProps.interruptedPredictionTurn).toEqual({
          chatId: "chat-b",
        });
      },
    );
  });

  describe("Scroll to bottom", () => {
    it("scrolls from the composer overlay and hides at the bottom or with expanded todos", () => {
      mockIsAtBottom = false;
      mockUseChat.mockReturnValue({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "Answer" }],
          },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });
      const view = () => (
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      const button = screen.getByRole("button", { name: "Scroll to bottom" });
      expect(
        button.closest("[data-chat-composer-overlay]"),
      ).toBeInTheDocument();
      fireEvent.click(button);
      expect(mockScrollToBottom).toHaveBeenCalledWith({ force: true });

      mockIsAtBottom = true;
      rerender(view());
      expect(
        screen.queryByRole("button", { name: "Scroll to bottom" }),
      ).toBeNull();

      mockIsAtBottom = false;
      mockDesktopState = { isTodoPanelExpanded: true };
      rerender(view());
      expect(
        screen.queryByRole("button", { name: "Scroll to bottom" }),
      ).toBeNull();
    });

    it("moves beside the mobile goal pill when it fits, never duplicating the button", async () => {
      const { useIsMobile } = require("@/hooks/use-mobile");
      const observers: ResizeObserverCallback[] = [];
      const originalResizeObserver = Object.getOwnPropertyDescriptor(
        globalThis,
        "ResizeObserver",
      );
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: class {
          constructor(callback: ResizeObserverCallback) {
            observers.push(callback);
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      });
      let pillRight = 200;
      const rectSpy = jest
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const right = this.matches('section[aria-label="Agent goal"]')
            ? 288
            : pillRight;
          return { right, height: 0 } as DOMRect;
        });
      try {
        useIsMobile.mockReturnValue(true);
        mockIsAtBottom = false;
        mockRouteParams = { id: "goal-chat" };
        mockRestoredChat = { id: "goal-chat", default_model_slug: "agent" };
        mockSavedGoal = {
          _id: "goal",
          state: "paused",
          objective: "Create marker",
          criteria: ["Marker exists"],
          evidence: [],
          reason: "Paused",
          updatedAt: 2000,
        };
        mockUseChat.mockReturnValue({
          ...mockUseChat(),
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [{ type: "text", text: "Answer" }],
            },
          ],
        });
        const view = () => (
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>
        );
        const { rerender } = render(view());
        await act(async () => {});
        const goalRegion = screen.getByRole("region", { name: "Agent goal" });
        let buttons = screen.getAllByRole("button", {
          name: "Scroll to bottom",
        });
        expect(buttons).toHaveLength(1);
        expect(goalRegion).toContainElement(buttons[0]);
        fireEvent.click(buttons[0]);
        expect(mockScrollToBottom).toHaveBeenCalledWith({ force: true });

        // Not enough room beside the pill: restore the floating placement.
        pillRight = 260;
        act(() =>
          observers.forEach((callback) => callback([], {} as ResizeObserver)),
        );
        buttons = screen.getAllByRole("button", { name: "Scroll to bottom" });
        expect(buttons).toHaveLength(1);
        expect(goalRegion).not.toContainElement(buttons[0]);

        // Expanded todos still suppress it in either placement.
        pillRight = 200;
        act(() =>
          observers.forEach((callback) => callback([], {} as ResizeObserver)),
        );
        mockDesktopState = { isTodoPanelExpanded: true };
        rerender(view());
        expect(
          screen.queryByRole("button", { name: "Scroll to bottom" }),
        ).toBeNull();
      } finally {
        rectSpy.mockRestore();
        useIsMobile.mockReturnValue(false);
        if (originalResizeObserver)
          Object.defineProperty(
            globalThis,
            "ResizeObserver",
            originalResizeObserver,
          );
        else Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    });
  });

  describe("Message Display", () => {
    it.each([false, true])(
      "keeps a rejected panel resume reply on mobile=%s",
      async (mobile) => {
        const toastError = jest.spyOn(toast, "error");
        require("@/hooks/use-mobile").useIsMobile.mockReturnValue(mobile);
        mockDesktopState = {
          chatMode: "agent",
          subscription: "pro",
          sandboxPreference: "e2b",
        };
        mockRouteParams = { id: "goal-chat" };
        mockRestoredChat = { id: "goal-chat", default_model_slug: "agent" };
        mockSavedGoal = {
          _id: "goal",
          state: "blocked",
          generation: 4,
          objective: "Use my chosen color",
          criteria: [],
          evidence: [],
          runs: 1,
          sandboxPreference: "e2b",
          permissionMode: "full_access",
          selectedModel: "auto",
        };
        global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
          ok: true,
          json: async () => ({ enabled: true }),
        } as Response);
        require("convex/react").useConvex().query.mockResolvedValueOnce(false);
        mockSendMessage.mockImplementationOnce(async () => {
          const options = mockUseChat.mock.calls.at(-1)![0] as {
            onError: (error: Error) => void;
          };
          const { ChatSDKError } = require("@/lib/errors");
          options.onError(
            new ChatSDKError(
              "bad_request:chat",
              "The goal changed. Reload before resuming.",
            ),
          );
        });
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        const openDetails = () => {
          if (mobile) {
            fireEvent.click(
              screen.getByRole("button", { name: "Show goal controls" }),
            );
            fireEvent.click(screen.getByRole("button", { name: /Details/ }));
          } else
            fireEvent.click(
              screen.getByRole("button", { name: "Show goal details" }),
            );
        };
        openDetails();
        fireEvent.change(screen.getByRole("textbox", { name: "Goal reply" }), {
          target: { value: "Use blue" },
        });
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Resume goal" }),
          ).toBeEnabled(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith(
            "The goal changed. Reload before resuming.",
          ),
        );
        if (mobile)
          fireEvent.click(
            screen.getByRole("button", { name: "Show goal controls" }),
          );
        expect(screen.getByRole("textbox", { name: "Goal reply" })).toHaveValue(
          "Use blue",
        );
        expect(screen.getByRole("alert")).toHaveTextContent("The goal changed");
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: expect.any(String),
            role: "user",
            parts: [
              {
                type: "text",
                text: "Resume goal: Use my chosen color\n\nUse blue",
              },
            ],
          }),
          expect.objectContaining({
            body: expect.objectContaining({
              goal: { action: "resume", expectedGeneration: 4 },
            }),
          }),
        );
        expect(mockClearError).toHaveBeenCalled();
        toastError.mockRestore();
      },
    );

    it("reports rejected editor continuation through goal admission", async () => {
      global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      } as Response);
      mockDesktopState = {
        chatMode: "agent",
        subscription: "pro",
        sandboxPreference: "e2b",
      };
      require("convex/react").useConvex().query.mockResolvedValueOnce(false);
      render(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open Computer" }));
      await screen.findByTestId("computer-sidebar");
      await act(async () => {
        await expect(
          mockContinueGoal({
            objective: "Use blue",
            generation: 4,
            sandboxPreference: "e2b",
            permissionMode: "full_access",
            selectedModel: "auto",
          }),
        ).rejects.toThrow("Goal could not start");
      });
      expect(mockClearError).toHaveBeenCalled();
    });

    it("dismisses completed goals from saved user messages, not optimistic sends or assistant updates", async () => {
      const convexReact = require("convex/react");
      mockRouteParams = { id: "goal-chat" };
      mockRestoredChat = { id: "goal-chat", default_model_slug: "agent" };
      mockSavedGoal = {
        _id: "goal",
        state: "achieved",
        objective: "Create marker",
        criteria: ["Marker exists"],
        evidence: [],
        runs: 1,
        maxRuns: 3,
        achievedAt: 2000,
        updatedAt: 2000,
      };
      const original = {
        id: "original",
        chat_id: "goal-chat",
        role: "user",
        parts: [{ type: "text", text: "Create marker" }],
        created_at: 1000,
      };
      const followup = { ...original, id: "followup", created_at: 3000 };
      const saved = (results: unknown[]) =>
        convexReact.setMockPaginatedQueryResult({
          results,
          status: "Exhausted",
          loadMore: jest.fn(),
          isLoading: false,
        });
      saved([original]);
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [{ ...followup, metadata: { createdAt: 3000 } }],
        error: new Error("Send failed"),
      });
      const view = () => (
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender, unmount } = render(view());
      expect(
        screen.getByRole("button", { name: "Show goal details" }),
      ).toBeVisible();
      saved([{ ...followup, role: "assistant" }, original]);
      rerender(view());
      expect(
        screen.getByRole("button", { name: "Show goal details" }),
      ).toBeVisible();
      saved([followup, original]);
      rerender(view());
      expect(
        screen.queryByRole("region", { name: "Agent goal" }),
      ).not.toBeInTheDocument();
      unmount();
      render(view());
      expect(
        screen.queryByRole("region", { name: "Agent goal" }),
      ).not.toBeInTheDocument();
      await act(async () => {});
    });
    it("waits for restored preferences before auto-sending a fork loaded after its draft", async () => {
      mockRouteParams = { id: "late-fork" };
      mockLocalConnections = [];
      sessionStorage.setItem("autoSendChatId", "late-fork");
      const view = () => (
        <TestWrapper>
          <ForkDraftSetter />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      mockRestoredChat = {
        id: "late-fork",
        sandbox_type: "desktop",
        default_model_slug: "agent",
      };
      mockUseChat.mockReturnValue({
        messages: [
          {
            id: "original",
            role: "user",
            parts: [{ type: "text", text: "original task" }],
          },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });
      rerender(view());
      expect(mockHandleSubmit).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("autoSendChatId")).toBe("late-fork");
      sessionStorage.removeItem("autoSendChatId");
    });

    it("preserves a fork's pending send until its selected computer reconnects", async () => {
      mockUseRealChatHandlers = true;
      mockRouteParams = { id: "fork-task" };
      mockRestoredChat = {
        id: "fork-task",
        sandbox_type: "desktop",
        default_model_slug: "agent",
      };
      mockLocalConnections = [];
      sessionStorage.setItem("autoSendChatId", "fork-task");
      mockUseChat.mockReturnValue({
        messages: [
          {
            id: "original",
            role: "user",
            parts: [{ type: "text", text: "original task" }],
          },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });
      const view = () => (
        <TestWrapper>
          <ForkDraftSetter />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      expect(mockHandleSubmit).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("autoSendChatId")).toBe("fork-task");
      mockLocalConnections = [{ connectionId: "desktop-row", isDesktop: true }];
      rerender(view());
      await waitFor(() =>
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "continue" }),
          expect.objectContaining({
            body: expect.objectContaining({ sandboxPreference: "desktop" }),
          }),
        ),
      );
      expect(sessionStorage.getItem("autoSendChatId")).toBeNull();
    });

    it("holds queued sends and rejects direct dispatch until the selected computer reconnects", async () => {
      mockLocalConnections = [];
      const view = () => (
        <TestWrapper>
          <DisconnectedQueueHarness />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      fireEvent.click(screen.getByRole("button", { name: "Queue continue" }));
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
      expect(mockSendMessage).not.toHaveBeenCalled();
      await expect(
        mockChatHandlerArgs.sendMessage({ text: "bypass" }),
      ).rejects.toThrow("Reconnect your computer");
      expect(mockSendMessage).not.toHaveBeenCalled();
      mockLocalConnections = [{ connectionId: "desktop-row", isDesktop: true }];
      rerender(view());
      await waitFor(() =>
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            parts: [{ type: "text", text: "continue" }],
          }),
          expect.objectContaining({
            body: expect.objectContaining({ sandboxPreference: "desktop" }),
          }),
        ),
      );
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
    });

    it("holds queued work while a Goal needs input or is blocked and releases it after completion", async () => {
      mockRouteParams = { id: "goal-queue-chat" };
      mockLocalConnections = [{ connectionId: "desktop-row", isDesktop: true }];
      mockRestoredChat = {
        id: "goal-queue-chat",
        sandbox_type: "desktop",
        default_model_slug: "agent",
      };
      mockSavedGoal = {
        state: "needs_input",
        generation: 4,
        objective: "Choose a label",
        criteria: ["Label received"],
      };
      const view = () => (
        <TestWrapper>
          <DisconnectedQueueHarness />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      fireEvent.click(screen.getByRole("button", { name: "Queue continue" }));
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
      // A reply in another tab publishes Goal admission before the run id.
      for (const state of ["blocked", "queued", "running"]) {
        mockSavedGoal = { ...mockSavedGoal, state };
        await act(async () => rerender(view()));
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
      }
      mockSavedGoal = { ...mockSavedGoal, state: "achieved" };
      await act(async () => rerender(view()));
      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    });

    it("holds queued work after a wait clears until the resumed run finishes", async () => {
      mockRouteParams = { id: "wait-queue-chat" };
      mockLocalConnections = [{ connectionId: "desktop-row", isDesktop: true }];
      mockRestoredChat = {
        id: "wait-queue-chat",
        sandbox_type: "desktop",
        default_model_slug: "agent",
        active_trigger_run_id: "resumed-run",
        active_agent_user_wait: {
          runId: "resumed-run",
          toolCallId: "wait-1",
          status: "waiting",
        },
      };
      const view = () => (
        <TestWrapper>
          <DisconnectedQueueHarness />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view());
      fireEvent.click(screen.getByRole("button", { name: "Queue continue" }));
      expect(mockSendMessage).not.toHaveBeenCalled();
      delete mockRestoredChat.active_agent_user_wait;
      await act(async () => rerender(view()));
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
      delete mockRestoredChat.active_trigger_run_id;
      await act(async () => rerender(view()));
      await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    });

    it("rejects goal sends when the SDK settles without admitting the request", async () => {
      mockDesktopState = { chatMode: "agent" };
      const client = require("convex/react").useConvex();
      client.query.mockResolvedValueOnce(false);
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      await expect(
        mockChatHandlerArgs.sendGoalMessage!(
          { text: "Use blue" },
          { body: { goal: { action: "resume", expectedGeneration: 4 } } },
        ),
      ).rejects.toThrow("could not start");
      expect(mockClearError).toHaveBeenCalled();
      const update = mockSetMessages.mock.calls.at(-1)![0] as (
        messages: { id: string }[],
      ) => { id: string }[];
      const payload = (
        mockSendMessage.mock.calls.at(-1) as unknown as [{ id: string }]
      )[0];
      expect(update([{ id: payload.id }, { id: "saved-message" }])).toEqual([
        { id: "saved-message" },
      ]);
    });

    it.each([true, undefined])(
      "preserves the optimistic message when persistence is %s",
      async (persisted) => {
        mockDesktopState = { chatMode: "agent" };
        require("convex/react")
          .useConvex()
          .query.mockResolvedValueOnce(persisted);
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        mockSetMessages.mockClear();
        await expect(
          mockChatHandlerArgs.sendGoalMessage!(
            { text: "Use blue" },
            { body: { goal: { action: "resume" } } },
          ),
        ).rejects.toBeInstanceOf(GoalSubmissionUnconfirmedError);
        expect(mockSetMessages).not.toHaveBeenCalled();
      },
    );

    it("preserves server guidance when goal admission is rejected", async () => {
      mockDesktopState = { chatMode: "agent" };
      require("convex/react")
        .useConvex()
        .query.mockResolvedValueOnce(undefined);
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      mockSendMessage.mockImplementationOnce(async () => {
        const options = mockUseChat.mock.calls.at(-1)![0] as {
          onError: (error: Error) => void;
        };
        const { ChatSDKError } = require("@/lib/errors");
        options.onError(
          new ChatSDKError(
            "bad_request:chat",
            "The goal changed. Reload before resuming.",
          ),
        );
      });
      await act(async () => {
        await expect(
          mockChatHandlerArgs.sendGoalMessage!({ text: "Use blue" }),
        ).rejects.toThrow("The goal changed. Reload before resuming.");
      });
    });

    it("releases a rejected goal submission when its persistence lookup cannot reconnect", async () => {
      jest.useFakeTimers();
      try {
        mockDesktopState = { chatMode: "agent" };
        const query = require("convex/react").useConvex().query;
        query.mockResolvedValue(undefined);
        query.mockImplementationOnce(() => new Promise(() => {}));
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        mockSetMessages.mockClear();
        let settled = false;
        const rejection = mockChatHandlerArgs.sendGoalMessage!({
          text: "Use blue",
        }).catch((error: Error) => {
          settled = true;
          return error;
        });
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5_000);
        });
        expect(settled).toBe(true);
        expect(await rejection).toEqual(
          expect.objectContaining({
            name: "GoalSubmissionUnconfirmedError",
          }),
        );
        expect(mockSetMessages).not.toHaveBeenCalled();
        expect(mockClearError).toHaveBeenCalled();
        await expect(
          mockChatHandlerArgs.sendGoalMessage!({ text: "Try again" }),
        ).rejects.toBeInstanceOf(GoalSubmissionUnconfirmedError);
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps a stopped submission distinct from rejected admission", async () => {
      mockDesktopState = { chatMode: "agent" };
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      mockSendMessage.mockImplementationOnce(async () => {
        const options = mockUseChat.mock.calls.at(-1)![0] as {
          onFinish: (value: { isAbort: boolean; isError: boolean }) => void;
        };
        options.onFinish({ isAbort: true, isError: false });
      });
      const query = require("convex/react").useConvex().query;
      query.mockClear();
      await act(async () => {
        await expect(
          mockChatHandlerArgs.sendGoalMessage!(
            { text: "Use blue" },
            { body: { goal: { action: "resume" } } },
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
      });
      expect(query).not.toHaveBeenCalled();
      expect(mockClearError).not.toHaveBeenCalled();
    });

    it("keeps a goal accepted when stream setup throws immediately after matching admission", async () => {
      mockDesktopState = { chatMode: "agent" };
      require("convex/react").useConvex().query.mockResolvedValue(false);
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      mockSendMessage.mockImplementationOnce(() => {
        const payload = mockSendMessage.mock.calls.at(-1)![0];
        const options = mockUseChat.mock.calls.at(-1)![0] as {
          transport: {
            fetch: (url: string, init: RequestInit) => Promise<Response>;
          };
        };
        mockFetchAgentLongStream.mockImplementationOnce(
          async (_init, onRunStarted) => {
            onRunStarted?.({
              chatId: "queued-message-id",
              runId: "admitted-goal-run",
            });
            throw new Error("Synthetic stream attachment failure");
          },
        );
        void options.transport
          .fetch("/api/chat", {
            method: "POST",
            body: JSON.stringify({
              chatId: "queued-message-id",
              messages: [payload],
            }),
          })
          .catch(() => {});
        return Promise.reject(new Error("Synthetic stream attachment failure"));
      });
      await act(async () => {
        await expect(
          mockChatHandlerArgs.sendGoalMessage!({ text: "Use blue" }),
        ).resolves.toBeUndefined();
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(require("convex/react").useConvex().query).not.toHaveBeenCalled();
    });

    it.each(["network", "http500", "stream"])(
      "keeps an issued start unconfirmed after %s failure before persistence is visible",
      async (failure) => {
        mockDesktopState = { chatMode: "agent" };
        require("convex/react").useConvex().query.mockResolvedValueOnce(false);
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        const { ChatSDKError } = require("@/lib/errors");
        const error =
          failure === "network"
            ? new TypeError("Load failed")
            : new ChatSDKError(
                failure === "stream" ? "bad_request:stream" : "bad_request:api",
              );
        if (failure === "http500") error.statusCode = 500;
        mockFetchAgentLongStream.mockRejectedValueOnce(error);
        mockSendMessage.mockImplementationOnce(async () => {
          const payload = mockSendMessage.mock.calls.at(-1)![0];
          const options = mockUseChat.mock.calls.at(-1)![0] as {
            transport: {
              fetch: (url: string, init: RequestInit) => Promise<Response>;
            };
          };
          await options.transport.fetch("/api/chat", {
            method: "POST",
            body: JSON.stringify({
              chatId: "queued-message-id",
              messages: [payload],
            }),
          });
        });
        mockSetMessages.mockClear();
        await act(async () => {
          await expect(
            mockChatHandlerArgs.sendGoalMessage!({ text: "Use blue" }),
          ).rejects.toBeInstanceOf(GoalSubmissionUnconfirmedError);
        });
        expect(mockSetMessages).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      },
    );

    it.each([false, true])(
      "handles detached admission separately from explicit Stop (stopped=%s)",
      async (stopped) => {
        mockDesktopState = { chatMode: "agent" };
        render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        mockSendMessage.mockImplementationOnce(async () => {
          const payload = mockSendMessage.mock.calls.at(-1)![0];
          const options = mockUseChat.mock.calls.at(-1)![0] as {
            transport: {
              fetch: (url: string, init: RequestInit) => Promise<Response>;
            };
            onFinish: (value: { isAbort: boolean; isError: boolean }) => void;
          };
          if (stopped) mockChatHandlerArgs.hasManuallyStoppedRef.current = true;
          mockFetchAgentLongStream.mockImplementationOnce(
            async (_init, _started, _closed, admitted) => {
              admitted?.({
                chatId: "queued-message-id",
                runId: "detached-goal-run",
              });
              throw new DOMException("Detached", "AbortError");
            },
          );
          try {
            await options.transport.fetch("/api/chat", {
              method: "POST",
              body: JSON.stringify({
                chatId: "queued-message-id",
                messages: [payload],
              }),
            });
          } catch {
            options.onFinish({ isAbort: true, isError: false });
          }
        });
        await act(async () => {
          const sending = mockChatHandlerArgs.sendGoalMessage!({
            text: "Use blue",
          });
          if (stopped)
            await expect(sending).rejects.toMatchObject({ name: "AbortError" });
          else await expect(sending).resolves.toBeUndefined();
        });
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      },
    );

    it("resolves goal sends at matching admission without waiting for the response stream", async () => {
      mockDesktopState = { chatMode: "agent" };
      let finish!: () => void;
      mockSendMessage.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      let resolved = false;
      const sending = Promise.resolve(
        mockChatHandlerArgs.sendGoalMessage!(
          { text: "Use blue" },
          { body: { goal: { action: "resume", expectedGeneration: 4 } } },
        ),
      ).then(() => {
        resolved = true;
      });
      const payload = (
        mockSendMessage.mock.calls.at(-1) as unknown as [unknown]
      )[0];
      const options = mockUseChat.mock.calls.at(-1)![0] as {
        transport: {
          fetch: (url: string, init: RequestInit) => Promise<Response>;
        };
      };
      mockFetchAgentLongStream.mockImplementationOnce(
        async (_init, onRunStarted) => {
          onRunStarted?.({
            chatId: "queued-message-id",
            runId: "synthetic-goal-run",
          });
          return {} as Response;
        },
      );
      try {
        await act(async () => {
          await options.transport.fetch("/api/chat", {
            method: "POST",
            body: JSON.stringify({
              chatId: "queued-message-id",
              messages: [payload],
            }),
          });
        });
        expect(resolved).toBe(true);
      } finally {
        await act(async () => {
          finish();
          await sending;
        });
      }
    });

    it("removes a queued item only when its actual Agent transport acknowledges the matching turn", async () => {
      mockLocalConnections = [{ connectionId: "desktop-row", isDesktop: true }];
      let finish!: () => void;
      mockSendMessage.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      render(
        <TestWrapper>
          <DisconnectedQueueHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Queue continue" }));
      await waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("1");
      const payload = (
        mockSendMessage.mock.calls.at(-1) as unknown as [unknown]
      )[0];
      const options = mockUseChat.mock.calls.at(-1)![0] as {
        transport: {
          fetch: (url: string, init: RequestInit) => Promise<Response>;
        };
      };
      mockFetchAgentLongStream.mockImplementationOnce(
        async (_init, onRunStarted) => {
          onRunStarted?.({
            chatId: "queued-message-id",
            runId: "synthetic-run",
          });
          return {} as Response;
        },
      );
      await act(async () => {
        await options.transport.fetch("/api/chat", {
          method: "POST",
          body: JSON.stringify({
            chatId: "queued-message-id",
            messages: [payload],
          }),
        });
      });
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("0");
      await act(async () => {
        finish();
      });
    });

    it("preserves automatic and manual Ask queue dispatch", async () => {
      render(
        <TestWrapper>
          <QueueEditingHarness mode="ask" />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
      await waitFor(() =>
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "updated queued message" }),
          expect.objectContaining({
            body: expect.objectContaining({ mode: "ask" }),
          }),
        ),
      );
      expect(screen.getByTestId("queue-state")).toHaveTextContent("Queued: 0");
      expect(mockChatHandlerArgs.sendQueuedMessage).toBeUndefined();
    });

    it("keeps an edited queued message pending, then resumes with updated text", async () => {
      render(
        <TestWrapper>
          <QueueEditingHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      await waitFor(() =>
        expect(screen.getByTestId("queue-state")).toHaveTextContent(
          "Queued: 1",
        ),
      );

      expect(mockSendMessage).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            parts: [{ type: "text", text: "updated queued message" }],
          }),
          expect.anything(),
        );
        expect(screen.getByTestId("queue-state")).toHaveTextContent(
          "Queued: 1",
        );
      });
    });
  });

  describe("Streaming State", () => {
    it("exposes a saved Ask task before a manual stop", async () => {
      window.history.replaceState({}, "", "/");
      mockDesktopState = { chatMode: "ask" };
      global.fetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue({ ok: true } as Response);
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      const options = mockUseChat.mock.calls.at(-1)![0] as {
        transport: {
          fetch: (url: string, init: RequestInit) => Promise<Response>;
        };
        onFinish: (result: { isAbort: boolean; isError: boolean }) => void;
      };
      await act(async () => {
        await options.transport.fetch("/api/chat", {
          method: "POST",
          body: JSON.stringify({ chatId: "queued-message-id", messages: [] }),
        });
      });
      expect(window.location.pathname).toBe("/c/queued-message-id");
      act(() => options.onFinish({ isAbort: true, isError: false }));
      expect(window.location.pathname).toBe("/c/queued-message-id");
      expect(mockChatHandlerArgs.isExistingChat).toBe(true);
    });

    it("does not turn an attachment admission error into a saved-task route on finish", () => {
      window.history.replaceState({}, "", "/");
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      const options = mockUseChat.mock.calls.at(-1)![0] as {
        onError: (error: Error) => void;
        onFinish: (result: { isAbort: boolean; isError: boolean }) => void;
      };
      act(() => {
        options.onError(new Error("Failed to prepare local attachments"));
        options.onFinish({ isAbort: false, isError: true });
      });
      expect(window.location.pathname).toBe("/");
      expect(mockChatHandlerArgs.isExistingChat).toBe(false);
    });
    it.each(["completed", "failed"])(
      "waits for the summary %s event, then sends the new message while the old response is still streaming",
      async (summaryStatus) => {
        mockUseRealChatHandlers = true;
        mockDesktopState = { queueBehavior: "stop-and-send" };
        mockUseChat.mockReturnValue({
          messages: [
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "Original task" }],
            },
          ],
          sendMessage: mockSendMessage,
          setMessages: mockSetMessages,
          status: "streaming",
          stop: mockStop,
          error: null,
          regenerate: mockRegenerate,
          resumeStream: mockResumeStream,
        });
        render(
          <TestWrapper>
            <ForkDraftSetter />
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        const onData = (part: unknown) => {
          const options = mockUseChat.mock.calls.at(-1)![0] as {
            onData: (part: unknown) => void;
          };
          act(() => options.onData(part));
        };
        onData({
          type: "data-summarization",
          data: { status: "started", message: "Preparing to continue…" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Submit test message" }),
        );
        expect(mockStop).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        onData({
          type: "data-summarization",
          data: { status: summaryStatus, message: "" },
        });
        await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
        expect(mockStop).toHaveBeenCalledTimes(1);
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "continue" }),
          expect.anything(),
        );
        onData({
          type: "data-summarization",
          data: { status: summaryStatus, message: "" },
        });
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps the local cancellation target when an older stream finishes before persisted state catches up", async () => {
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      expect(mockChatHandlerArgs.activeTriggerRunRef?.current).toBeUndefined();
      const options = mockUseChat.mock.calls.at(-1)![0] as {
        onData: (part: unknown) => void;
        onFinish: (result: { isAbort: boolean }) => void;
        transport: {
          fetch: (url: string, init: RequestInit) => Promise<Response>;
        };
      };
      mockResumeAgentLongStream.mockResolvedValueOnce({} as Response);
      await options.transport.fetch(
        "/api/agent/resume?chatId=queued-message-id",
        { method: "GET" },
      );
      const onRunClosed = mockResumeAgentLongStream.mock.calls.at(-1)![2]!;
      act(() =>
        options.onData({
          type: "data-agent-run-correlation",
          data: { runId: "run-local-before-query", token: "synthetic" },
        }),
      );
      expect(mockChatHandlerArgs.activeTriggerRunRef?.current).toBe(
        "run-local-before-query",
      );
      act(() => options.onFinish({ isAbort: true }));
      act(() => onRunClosed("run-previous"));
      expect(mockChatHandlerArgs.activeTriggerRunRef?.current).toBe(
        "run-local-before-query",
      );
      act(() => onRunClosed("run-local-before-query"));
      expect(mockChatHandlerArgs.activeTriggerRunRef?.current).toBeUndefined();
    });
  });

  describe("Error Handling", () => {
    it("should render when error occurs", () => {
      const testError = new Error("Test error");
      mockUseChat.mockReturnValue({
        messages: [],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: testError,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    });
  });

  describe("Sidebar Behavior", () => {
    it("preserves an open editor draft across split and overlay layouts", async () => {
      const view = (
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>
      );
      const { rerender } = render(view);
      fireEvent.click(screen.getByRole("button", { name: "Open Computer" }));
      fireEvent.change(
        await screen.findByRole("textbox", { name: "Computer draft" }),
        { target: { value: "Unsaved goal edits" } },
      );
      mockComputerOverlayMedia = true;
      rerender(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      expect(
        screen.getByRole("dialog", { name: "HackerAI’s Computer" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "Computer draft" }),
      ).toHaveValue("Unsaved goal edits");
      mockComputerOverlayMedia = false;
      rerender(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      expect(
        screen.queryByRole("dialog", { name: "HackerAI’s Computer" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "Computer draft" }),
      ).toHaveValue("Unsaved goal edits");
    });
    it("restarts takeover with a hidden signal without replaying the private popup note", async () => {
      render(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open Computer" }));
      await screen.findByTestId("computer-sidebar");
      // An older backend may still return the note; never echo or overwrite it.
      await act(async () => {
        await expect(
          mockBrowserContinue({
            id: "private-note-id",
            text: "STOP! /LAB?X=YES café 日本語 😀",
          }),
        ).rejects.toThrow("Your note is saved");
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "private-note-id-continue",
          role: "user",
          metadata: { isAutoContinue: true },
          parts: [{ type: "text", text: "Continue after browser takeover." }],
        }),
        {
          body: expect.objectContaining({
            mode: "agent",
            isAutoContinue: true,
          }),
        },
      );
      expect(JSON.stringify(mockSendMessage.mock.calls)).not.toContain("STOP!");
    });

    it("should render sidebar on desktop", () => {
      render(
        <TestWrapper>
          <ChatLayout>
            <Chat autoResume={false} />
          </ChatLayout>
        </TestWrapper>,
      );

      expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    });

    it("uses a bounded split pane for Computer on wide workspaces", async () => {
      render(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Open Computer" }));

      await waitFor(() => {
        expect(screen.getByTestId("computer-sidebar")).toBeInTheDocument();
      });
      expect(screen.getByTestId("computer-sidebar-container")).toHaveAttribute(
        "data-layout",
        "split",
      );
      expect(screen.getByTestId("computer-sidebar-container")).toHaveClass(
        "w-1/2",
      );
    });

    it("preserves the Computer controller across responsive layout changes", async () => {
      render(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open Computer" }));
      const controller = await screen.findByTestId("computer-sidebar");
      for (const overlay of [true, false]) {
        act(() => {
          mockComputerOverlayMedia = overlay;
          mockOverlayListeners.forEach((listener) => listener());
        });
        expect(
          screen.getByTestId("computer-sidebar-container"),
        ).toHaveAttribute("data-layout", overlay ? "overlay" : "split");
        expect(screen.getByTestId("computer-sidebar")).toBe(controller);
      }
    });

    it.each([true, false])(
      "restores a goal control before the editor loads (trigger focused: %s)",
      async (focusTrigger) => {
        mockComputerOverlayMedia = true;
        const GoalSidebarHarness = () => {
          const { openSidebar, sidebarOpen } = useGlobalState();
          return sidebarOpen ? null : (
            <button
              aria-label="Edit goal"
              onClick={() => openSidebar({ kind: "goal", chatId: "chat-1" })}
            >
              Edit
            </button>
          );
        };
        render(
          <TestWrapper>
            <GoalSidebarHarness />
            <Chat autoResume={false} />
          </TestWrapper>,
        );
        const trigger = screen.getByRole("button", { name: "Edit goal" });
        if (focusTrigger) trigger.focus();
        fireEvent.click(trigger);
        const dialog = await screen.findByRole("dialog", { name: "Edit goal" });
        // The sidebar shell can mount before the dynamically loaded goal textarea.
        expect(
          screen.queryByRole("textbox", { name: "Goal objective" }),
        ).not.toBeInTheDocument();
        dialog.focus();
        fireEvent.keyDown(dialog, { key: "Escape" });
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Edit goal" }),
          ).toHaveFocus(),
        );
      },
    );

    it("uses an accessible Computer overlay on narrow workspaces", async () => {
      mockComputerOverlayMedia = true;
      const rects = jest
        .spyOn(HTMLElement.prototype, "getClientRects")
        .mockImplementation(function (this: HTMLElement) {
          return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
        });

      render(
        <TestWrapper>
          <OpenComputerSidebarHarness />
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      const trigger = screen.getByRole("button", { name: "Open Computer" });
      trigger.focus();
      fireEvent.click(trigger);

      expect(screen.getByTestId("computer-open-state")).toHaveTextContent(
        "open",
      );
      expect(
        await screen.findByTestId("computer-sidebar-container"),
      ).toHaveAttribute("data-layout", "overlay");
      expect(
        screen.getByRole("dialog", { name: "HackerAI’s Computer" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("computer-sidebar")).toBeInTheDocument();

      const firstAction = screen.getByRole("button", {
        name: "First computer action",
      });
      const lastAction = screen.getByText("More computer actions");
      await waitFor(() => expect(firstAction).toHaveFocus());

      // Portal dialogs (browser takeover / exit prompt) own their keyboard focus.
      const portal = document.createElement("div");
      portal.setAttribute("role", "dialog");
      const portalInput = document.createElement("input");
      portal.append(portalInput);
      document.body.append(portal);
      try {
        portalInput.focus();
        fireEvent.keyDown(portalInput, { key: "Escape" });
        expect(screen.getByTestId("computer-open-state")).toHaveTextContent(
          "open",
        );
        expect(portalInput).toHaveFocus();
      } finally {
        portal.remove();
      }

      lastAction.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(firstAction).toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(lastAction).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "HackerAI’s Computer" }),
        ).not.toBeInTheDocument();
      });
      expect(trigger).toHaveFocus();
      rects.mockRestore();
    });

    // Mobile task navigation is covered by ChatLayout accessibility tests.
  });
});
