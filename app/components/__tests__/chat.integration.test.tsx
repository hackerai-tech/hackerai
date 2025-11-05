import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, waitFor, act } from "@testing-library/react";
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

// next/navigation is mocked via __mocks__/next/navigation.ts

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

// Mock all complex nested components that use problematic hooks
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

// Mock all child components to avoid complex dependency chains
jest.mock("../Messages", () => ({
  Messages: ({ messages, status }: any) => (
    <div data-testid="messages-component">
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="status">{status}</div>
    </div>
  ),
}));

jest.mock("../ChatInput", () => ({
  ChatInput: (props: any) => (
    <div data-testid="chat-input-component">
      <button
        data-testid="submit-button"
        onClick={() => props.onSubmit && props.onSubmit({ text: "test message" })}
      >
        Submit
      </button>
      <button data-testid="stop-button" onClick={props.onStop}>
        Stop
      </button>
      <div data-testid="input-status">{props.status}</div>
      <div data-testid="is-new-chat">{props.isNewChat ? "new" : "existing"}</div>
    </div>
  ),
}));

jest.mock("../ComputerSidebar", () => ({
  ComputerSidebar: () => <div data-testid="computer-sidebar">Sidebar</div>,
}));

jest.mock("../ChatHeader", () => ({
  __esModule: true,
  default: (props: any) => (
    <div data-testid="chat-header">
      <div data-testid="chat-title">{props.chatTitle || "No title"}</div>
      <div data-testid="is-existing-chat">
        {props.isExistingChat ? "existing" : "new"}
      </div>
      <div data-testid="is-chat-not-found">
        {props.isChatNotFound ? "not-found" : "found"}
      </div>
    </div>
  ),
}));

// Mock Sidebar completely to avoid importing its dependencies
jest.mock("../Sidebar", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: () => React.createElement("div", { "data-testid": "main-sidebar" }, "Main Sidebar"),
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

describe("Chat - Integration Tests", () => {
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

  describe("Chat Initialization", () => {
    it("should render new chat with welcome message when no chatId provided", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      // Component should render successfully
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
      expect(screen.getByText("HackerAI")).toBeInTheDocument();
      expect(screen.getByText("Your AI pentest assistant")).toBeInTheDocument();
    });

    it("should render existing chat when chatId provided", () => {
      const { container } = render(
        <TestWrapper>
          <Chat chatId="test-chat-id" autoResume={false} />
        </TestWrapper>
      );

      // Component should render without errors
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render with provided chatId", () => {
      const chatId = "test-chat-123";

      const { container } = render(
        <TestWrapper>
          <Chat chatId={chatId} autoResume={false} />
        </TestWrapper>
      );

      // Component should render successfully with chatId
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render with generated UUID for new chat", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      // Component should render successfully
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Message Display", () => {
    it("should render when chat has messages", () => {
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

      // Component should render with messages
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should show welcome screen when no messages", () => {
      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(screen.getByText("HackerAI")).toBeInTheDocument();
    });
  });

  describe("Message Sending", () => {
    it("should render without errors", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should render during streaming status", () => {
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
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });

    it("should handle streaming state properly", () => {
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
        </TestWrapper>
      );

      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Error Handling", () => {
    it("should handle error state and still render", () => {
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

      // Component should still render despite error
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
      expect(screen.getByText("HackerAI")).toBeInTheDocument();
    });
  });

  describe("Chat Not Found", () => {
    it("should render without crashing when chatId is provided", () => {
      const { container } = render(
        <TestWrapper>
          <Chat chatId="non-existent-chat" autoResume={false} />
        </TestWrapper>
      );

      // Component should render without crashing even with non-existent chatId
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
    });
  });

  describe("Sidebar Integration", () => {
    it("should render main sidebar on desktop", () => {
      const { useIsMobile } = require("@/hooks/use-mobile");
      (useIsMobile as jest.Mock).mockReturnValue(false);

      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      // Sidebar should be rendered on desktop (check for sidebar wrapper class)
      const sidebarWrapper = container.querySelector('[data-slot="sidebar-wrapper"]');
      expect(sidebarWrapper).toBeInTheDocument();
    });

    it("should not render desktop sidebar on mobile", () => {
      const { useIsMobile } = require("@/hooks/use-mobile");
      (useIsMobile as jest.Mock).mockReturnValue(true);

      render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      expect(screen.queryByTestId("main-sidebar")).not.toBeInTheDocument();
    });
  });

  describe("Chat Lifecycle", () => {
    it("should initialize and render properly", () => {
      const { container } = render(
        <TestWrapper>
          <Chat autoResume={false} />
        </TestWrapper>
      );

      // Component should render successfully
      expect(container.querySelector(".h-full.bg-background")).toBeInTheDocument();
      expect(screen.getByText("HackerAI")).toBeInTheDocument();
    });
  });
});
