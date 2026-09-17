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
import { useEffect, useRef } from "react";

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
const mockHandleSubmit = jest.fn();
const mockRegenerate = jest.fn();
const mockResumeStream = jest.fn();
const mockResumeAgentLongStream =
  jest.fn<
    typeof import("@/lib/chat/agent-long-transport").resumeAgentLongStream
  >();
jest.mock("@/lib/chat/agent-long-transport", () => ({
  ...jest.requireActual<typeof import("@/lib/chat/agent-long-transport")>(
    "@/lib/chat/agent-long-transport",
  ),
  resumeAgentLongStream: (
    ...args: Parameters<typeof mockResumeAgentLongStream>
  ) => mockResumeAgentLongStream(...args),
}));
let mockRouteParams: Record<string, string> = {};
let mockComputerOverlayMedia = false;
const originalMatchMedia = window.matchMedia;

let mockUseRealChatHandlers = false;
let mockLocalConnections:
  Array<{ connectionId: string; isDesktop: boolean }> | undefined;
let mockChatHandlerArgs: Parameters<
  typeof import("@/app/hooks/useChatHandlers").useChatHandlers
>[0];
let mockRestoredChat:
  { id: string; sandbox_type?: string; default_model_slug: string } | undefined;
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
    useQuery: (query: any, ...args: any[]) => {
      const { getFunctionName } = require("convex/server");
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
    push: jest.fn(),
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

jest.mock("../../hooks/useMessageScroll", () => ({
  useMessageScroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    scrollToBottom: jest.fn(),
    isAtBottom: true,
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
  Messages: ({ messages }: any) => (
    <div data-testid="messages-component">{messages.length} messages</div>
  ),
}));

jest.mock("../ChatInput", () => ({
  ChatInput: () => <div data-testid="chat-input">ChatInput</div>,
}));

jest.mock("../ComputerSidebar", () => ({
  ComputerSidebar: () => (
    <div data-testid="computer-sidebar">
      Sidebar
      <button type="button">First computer action</button>
      <button type="button">Last computer action</button>
    </div>
  ),
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

const { useComposerActions } = jest.requireActual<
  typeof import("@/app/contexts/ComposerState")
>("@/app/contexts/ComposerState");
const ForkDraftSetter = () => {
  const { setInput } = useComposerActions();
  useEffect(() => setInput("continue"), [setInput]);
  return null;
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

const QueueEditingHarness = () => {
  const {
    messageQueue,
    queueMessage,
    updateQueuedMessage,
    setEditingQueuedMessageId,
  } = useGlobalState();
  const hasSetActualEditingId = useRef(false);

  useEffect(() => {
    queueMessage("original queued message");
    setEditingQueuedMessageId("queued-message-id");
  }, [queueMessage, setEditingQueuedMessageId]);

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
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const convexReact = require("convex/react");
    convexReact.resetMockConvexAuth?.();
    convexReact.resetMockConvexQueries?.();
    mockRouteParams = {};
    mockRestoredChat = undefined;
    mockDesktopState = {};
    mockLocalConnections = undefined;
    mockUseRealChatHandlers = false;
    window.localStorage.clear();
    mockComputerOverlayMedia = false;
    window.matchMedia = jest.fn(
      (query: string) =>
        ({
          get matches() {
            return query === "(max-width: 949px)" && mockComputerOverlayMedia;
          },
          media: query,
          onchange: null,
          addEventListener: jest.fn(),
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
      status: "ready",
      stop: mockStop,
      error: null,
      regenerate: mockRegenerate,
      resumeStream: mockResumeStream,
    });
  });

  describe("Basic Rendering", () => {
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

    it.each([undefined, "e2b", "desktop", "tauri", "missing-remote"])(
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

    it("should render with provided chatId", () => {
      mockRouteParams = { id: "test-chat-123" };

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(
        container.querySelector(".flex.bg-background"),
      ).toBeInTheDocument();
    });

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

  describe("Message Display", () => {
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
          expect.objectContaining({ text: "continue" }),
          expect.objectContaining({
            body: expect.objectContaining({ sandboxPreference: "desktop" }),
          }),
        ),
      );
      expect(screen.getByTestId("pending-queue")).toHaveTextContent("0");
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
          expect.objectContaining({ text: "updated queued message" }),
          expect.anything(),
        );
        expect(screen.getByTestId("queue-state")).toHaveTextContent(
          "Queued: 0",
        );
      });
    });

    it("should render with existing messages", () => {
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "Hello" },
          { id: "2", role: "assistant", content: "Hi there!" },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(
        container.querySelector(".flex.bg-background"),
      ).toBeInTheDocument();
    });
  });

  describe("Streaming State", () => {
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

    it("should handle streaming status", () => {
      mockUseChat.mockReturnValue({
        messages: [{ id: "1", role: "assistant", content: "Streaming..." }],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "streaming",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(
        container.querySelector(".flex.bg-background"),
      ).toBeInTheDocument();
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

    it("uses an accessible Computer overlay on narrow workspaces", async () => {
      mockComputerOverlayMedia = true;

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
      const lastAction = screen.getByRole("button", {
        name: "Last computer action",
      });
      await waitFor(() => expect(firstAction).toHaveFocus());

      lastAction.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(firstAction).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "HackerAI’s Computer" }),
        ).not.toBeInTheDocument();
      });
      expect(trigger).toHaveFocus();
    });

    // Mobile task navigation is covered by ChatLayout accessibility tests.
  });
});
