import "@testing-library/jest-dom";
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  beforeAll,
} from "@jest/globals";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDialog } from "../ShareDialog";

// Create mocks that will be properly hoisted
const mockShareChatFn = jest.fn();
const mockUpdateShareDateFn = jest.fn();
const mockUseQueryFn = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

// Mock sonner
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

// Mock MemoizedMarkdown
jest.mock("@/app/components/MemoizedMarkdown", () => ({
  MemoizedMarkdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

// Mock HackerAISVG
jest.mock("@/components/icons/hackerai-svg", () => ({
  HackerAISVG: () => <div data-testid="hackerai-svg">Logo</div>,
}));

// Mock Convex api
jest.mock("@/convex/_generated/api", () => ({
  api: {
    chats: {
      shareChat: "chats.shareChat",
      updateShareDate: "chats.updateShareDate",
    },
    messages: {
      getPreviewMessages: "messages.getPreviewMessages",
    },
  },
}));

// Mock Convex hooks - useMutation returns same mock for all calls
// since both shareChat and updateShareDate have same signature
jest.mock("convex/react", () => ({
  useMutation: jest.fn(() => mockShareChatFn),
  useQuery: jest.fn(() => mockUseQueryFn()),
}));

// Mock clipboard
const mockWriteText = jest.fn();
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

// Mock window.open
const mockWindowOpen = jest.fn();
global.window.open = mockWindowOpen;

// Mock window.location
delete (window as any).location;
(window as any).location = { origin: "http://localhost:3000" };

describe("ShareDialog", () => {
  const defaultProps = {
    open: false,
    onOpenChange: jest.fn(),
    chatId: "test-chat-id",
    chatTitle: "Test Chat",
  };

  beforeEach(() => {
    // Clear only call history
    mockShareChatFn.mockClear();
    mockUpdateShareDateFn.mockClear();
    mockUseQueryFn.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockWriteText.mockClear();
    mockWindowOpen.mockClear();
  });

  beforeAll(() => {
    // Set up default implementations once
    mockShareChatFn.mockImplementation(() =>
      Promise.resolve({
        shareId: "test-share-id",
        shareDate: Date.now(),
      }),
    );
    mockUpdateShareDateFn.mockImplementation(() =>
      Promise.resolve({
        shareDate: Date.now(),
      }),
    );
    mockUseQueryFn.mockReturnValue(undefined);
    mockWriteText.mockResolvedValue(undefined);
  });

  describe("Basic Rendering", () => {
    it("should not render when closed", () => {
      render(<ShareDialog {...defaultProps} open={false} />);
      expect(screen.queryByText("Test Chat")).not.toBeInTheDocument();
    });

    it("should render dialog title when open", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(screen.getByText("Test Chat")).toBeInTheDocument();
    });

    it("should render close button", () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(screen.getByLabelText("Close")).toBeInTheDocument();
    });

    it("should render accessibility description", () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(
        screen.getByText("Share this conversation via a public link"),
      ).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("should show loading message initially", () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(screen.getByText("Generating share link...")).toBeInTheDocument();
    });
  });

  describe("Error Handling", () => {
    it("should show error message on failure", async () => {
      mockShareChatFn.mockRejectedValue(new Error("Network error"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to generate share link. Please try again."),
        ).toBeInTheDocument();
      });
    });

    it("should show retry button on error", async () => {
      mockShareChatFn.mockRejectedValue(new Error("Network error"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Try again")).toBeInTheDocument();
      });
    });
  });

  describe("Dialog Close", () => {
    it("should call onOpenChange when close button clicked", () => {
      const mockOnOpenChange = jest.fn();

      render(
        <ShareDialog
          {...defaultProps}
          open={true}
          onOpenChange={mockOnOpenChange}
        />,
      );

      fireEvent.click(screen.getByLabelText("Close"));

      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle long chat titles", () => {
      const longTitle = "A".repeat(100);

      render(
        <ShareDialog {...defaultProps} open={true} chatTitle={longTitle} />,
      );

      expect(screen.getByText(longTitle)).toBeInTheDocument();
    });

    it("should handle special characters in title", () => {
      const specialTitle = "Test <>&\"' Title";

      render(
        <ShareDialog {...defaultProps} open={true} chatTitle={specialTitle} />,
      );

      expect(screen.getByText(specialTitle)).toBeInTheDocument();
    });
  });
});
