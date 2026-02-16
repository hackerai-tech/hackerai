import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen } from "@testing-library/react";

// ===== IMPORTANT: Mock all dependencies BEFORE importing Chat =====
// These mocks are hoisted by Jest

// Mock @ai-sdk/react
const mockSendMessage = jest.fn();
const mockSetMessages = jest.fn();
const mockStop = jest.fn();
const mockRegenerate = jest.fn();
const mockResumeStream = jest.fn();

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

jest.mock("react-hotkeys-hook", () => ({
  useHotkeys: jest.fn(),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: jest.fn(() => false),
}));

jest.mock("@/lib/utils/client-storage", () => ({
  NULL_THREAD_DRAFT_ID: "null-thread",
  getDraftContentById: jest.fn(() => null),
  upsertDraft: jest.fn(),
  removeDraft: jest.fn(),
}));

jest.mock("../../hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileInputRef: { current: null },
    handleFileUploadEvent: jest.fn(),
    handleRemoveFile: jest.fn(),
    handleAttachClick: jest.fn(),
    handlePasteEvent: jest.fn(),
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
  useChatHandlers: () => ({
    handleSubmit: jest.fn(),
    handleStop: jest.fn(),
    handleRegenerate: jest.fn(),
    handleRetry: jest.fn(),
    handleEditMessage: jest.fn(),
  }),
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
  ComputerSidebar: () => <div data-testid="computer-sidebar">Sidebar</div>,
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
import { Chat } from "../chat";
import { ChatLayout } from "../ChatLayout";
import { TestWrapper } from "../testUtils";

describe("Chat Component Integration", () => {
  let mockUseChat: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
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
    it("should render new chat with welcome message", () => {
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>,
      );

      expect(screen.getByText("HackerAI")).toBeInTheDocument();
      expect(screen.getByText("Your AI pentest assistant")).toBeInTheDocument();
    });

    it("should render with provided chatId", () => {
      const { container } = render(
        <TestWrapper>
          <Chat chatId="test-chat-123" autoResume={false} />
        </TestWrapper>,
      );

      expect(
        container.querySelector(".flex.bg-background"),
      ).toBeInTheDocument();
    });
  });

  describe("Message Display", () => {
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

      expect(screen.getByText("HackerAI")).toBeInTheDocument();
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

    // Mobile layout (sidebar hidden in main layout, shown as overlay) is covered by
    // ChatLayout structure and useIsMobile; full behavior can be asserted in e2e or ChatLayout unit tests.
  });
});
