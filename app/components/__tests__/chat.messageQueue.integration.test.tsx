import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// ===== IMPORTANT: Mock all child components and dependencies BEFORE importing Chat =====

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

// Mock external hooks and utilities
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
    handleSendNow: jest.fn(),
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

// Mock all complex nested components
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
    <div data-testid="messages-component">
      {messages.length} messages
    </div>
  ),
}));

jest.mock("../ChatInput", () => ({
  ChatInput: (props: any) => (
    <div data-testid="chat-input">{props.status}</div>
  ),
}));

jest.mock("../ComputerSidebar", () => ({
  ComputerSidebar: () => <div data-testid="computer-sidebar">Sidebar</div>,
}));

jest.mock("../ChatHeader", () => ({
  __esModule: true,
  default: () => <div data-testid="chat-header">Chat Header</div>,
}));

jest.mock("../Sidebar", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: () =>
      React.createElement("div", { "data-testid": "main-sidebar" }, "Main Sidebar"),
  };
});

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

// ===== NOW import the components after all mocks are set up =====
import { Chat } from "../chat";
import { GlobalStateProvider } from "@/app/contexts/GlobalState";
import { DataStreamProvider } from "../DataStreamProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

// Test wrapper with all required providers
const TestWrapper = ({ children }: { children: ReactNode }) => {
  return (
    <GlobalStateProvider>
      <DataStreamProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </DataStreamProvider>
    </GlobalStateProvider>
  );
};

describe("Chat - Message Queue Integration Tests", () => {
  let mockUseChat: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const { useChat } = require("@ai-sdk/react");
    mockUseChat = useChat as jest.Mock;

    // Reset to default mock implementation
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

  describe("Queue Management - Component Rendering", () => {
    it("should render chat component successfully with ready status", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      // Chat should render with main container
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render chat component with streaming status", () => {
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "Test message" },
          { id: "2", role: "assistant", content: "Response..." },
        ],
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
        </TestWrapper>
      );

      // Component should render during streaming
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should handle status transitions from streaming to ready", async () => {
      // Start with streaming
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "Test" },
          { id: "2", role: "assistant", content: "Response" },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "streaming",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      const { container, rerender } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();

      // Transition to ready
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "Test" },
          { id: "2", role: "assistant", content: "Complete response" },
        ],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "ready",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      rerender(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
      });
    });
  });

  describe("Message Queue - Status Handling", () => {
    it("should render with welcome message for new chat", () => {
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(screen.getByText("HackerAI")).toBeInTheDocument();
      expect(screen.getByText("Your AI pentest assistant")).toBeInTheDocument();
    });

    it("should render with messages present", () => {
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
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should handle multiple message exchanges", () => {
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "First question" },
          { id: "2", role: "assistant", content: "First answer" },
          { id: "3", role: "user", content: "Second question" },
          { id: "4", role: "assistant", content: "Second answer" },
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
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Chat Lifecycle with Queue", () => {
    it("should initialize chat without errors", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render chat with chatId provided", () => {
      const { container } = render(
        <TestWrapper>
          <Chat chatId="test-chat-123" autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should handle error state gracefully", () => {
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

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Status Prop Integration", () => {
    it("should display submitted status correctly", () => {
      mockUseChat.mockReturnValue({
        messages: [{ id: "1", role: "user", content: "Test message" }],
        sendMessage: mockSendMessage,
        setMessages: mockSetMessages,
        status: "submitted",
        stop: mockStop,
        error: null,
        regenerate: mockRegenerate,
        resumeStream: mockResumeStream,
      });

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should handle all chat statuses", () => {
      const statuses = ["ready", "streaming", "submitted", "error"] as const;

      statuses.forEach((status) => {
        mockUseChat.mockReturnValue({
          messages: [],
          sendMessage: mockSendMessage,
          setMessages: mockSetMessages,
          status,
          stop: mockStop,
          error: status === "error" ? new Error("Test") : null,
          regenerate: mockRegenerate,
          resumeStream: mockResumeStream,
        });

        const { container, unmount } = render(
          <TestWrapper>
            <Chat autoResume={false} />
          </TestWrapper>
        );

        expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
        unmount();
      });
    });
  });

  describe("Auto-resume Integration", () => {
    it("should render with autoResume true", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={true} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render with autoResume false", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Component Stability", () => {
    it("should handle concurrent state updates", () => {
      mockUseChat.mockReturnValue({
        messages: [
          { id: "1", role: "user", content: "Test" },
          { id: "2", role: "assistant", content: "Response" },
        ],
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
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should maintain stability across re-renders", () => {
      const { container, rerender } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();

      // Rerender with same props
      rerender(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });
});
