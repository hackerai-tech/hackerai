import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDialog } from "../ShareDialog";

// Create global mocks that will be accessible in tests
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

// Mock sonner
jest.mock("sonner", () => ({
  toast: {
    success: (...args: any[]) => mockToastSuccess(...args),
    error: (...args: any[]) => mockToastError(...args),
  },
}));

// Mock MemoizedMarkdown component
jest.mock("@/app/components/MemoizedMarkdown", () => ({
  MemoizedMarkdown: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

// Mock HackerAISVG component
jest.mock("@/components/icons/hackerai-svg", () => ({
  HackerAISVG: () => <div data-testid="hackerai-svg">Logo</div>,
}));

// Mock Convex hooks - create mocks in the factory
jest.mock("convex/react", () => {
  const actualMockShareChat = jest.fn();
  const actualMockUseQuery = jest.fn();

  // Store globally so tests can access
  (global as any).mockShareChat = actualMockShareChat;
  (global as any).mockUseQuery = actualMockUseQuery;

  return {
    useMutation: jest.fn(() => actualMockShareChat),
    useQuery: (...args: any[]) => actualMockUseQuery(...args),
  };
});

// Get references to the mocks
const mockShareChat = (global as any).mockShareChat || jest.fn();
const mockUpdateShareDate = jest.fn();
const mockUseQuery = (global as any).mockUseQuery || jest.fn();

// Mock clipboard API
const mockWriteText = jest.fn();
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

// Mock window.open
const mockWindowOpen = jest.fn();
global.window.open = mockWindowOpen;

describe("ShareDialog", () => {
  const defaultProps = {
    open: false,
    onOpenChange: jest.fn(),
    chatId: "test-chat-id",
    chatTitle: "Test Chat Title",
  };

  const mockPreviewMessages = [
    {
      id: "msg1",
      role: "user" as const,
      content: "Hello, what is React?",
    },
    {
      id: "msg2",
      role: "assistant" as const,
      content: "React is a JavaScript library for building user interfaces.",
    },
  ];

  beforeEach(() => {
    // Reset mocks completely
    mockShareChat.mockReset().mockResolvedValue({
      shareId: "new-share-id",
      shareDate: Date.now(),
    });

    mockUpdateShareDate.mockReset().mockResolvedValue({
      shareDate: Date.now(),
    });

    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockUseQuery.mockReset().mockReturnValue(undefined);
    mockWriteText.mockReset().mockResolvedValue(undefined);
    mockWindowOpen.mockReset();
  });

  describe("Basic Rendering", () => {
    it("should not render when open is false", () => {
      render(<ShareDialog {...defaultProps} open={false} />);
      expect(screen.queryByText("Test Chat Title")).not.toBeInTheDocument();
    });

    it("should render dialog when open is true", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(screen.getByText("Test Chat Title")).toBeInTheDocument();
    });

    it("should render close button", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      const closeButton = screen.getByLabelText("Close");
      expect(closeButton).toBeInTheDocument();
    });

    it("should display dialog description for accessibility", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);
      expect(
        screen.getByText("Share this conversation via a public link"),
      ).toBeInTheDocument();
    });
  });

  describe("Auto-generation of Share Link", () => {
    it("should auto-generate share link when dialog opens without existing share", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockShareChat).toHaveBeenCalledWith({ chatId: "test-chat-id" });
      });
    });

    it("should not generate share link when dialog is closed", () => {
      render(<ShareDialog {...defaultProps} open={false} />);
      expect(mockShareChat).not.toHaveBeenCalled();
    });

    it("should display social share buttons after successful generation", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Copy link")).toBeInTheDocument();
      });

      expect(screen.getByText("X")).toBeInTheDocument();
      expect(screen.getByText("LinkedIn")).toBeInTheDocument();
      expect(screen.getByText("Reddit")).toBeInTheDocument();
    });
  });

  describe("Existing Share Auto-update", () => {
    it("should update existing share when dialog opens with existingShareId", async () => {
      render(
        <ShareDialog
          {...defaultProps}
          open={true}
          existingShareId="existing-id"
          existingShareDate={Date.now() - 10000}
        />,
      );

      await waitFor(() => {
        expect(mockShareChat).toHaveBeenCalledWith({
          chatId: "test-chat-id",
        });
      });
    });
  });

  describe("Loading States", () => {
    it("should show loading state while generating share link", async () => {
      let resolveShare: (value: any) => void;
      const sharePromise = new Promise((resolve) => {
        resolveShare = resolve;
      });
      mockShareChat.mockReturnValue(sharePromise);

      render(<ShareDialog {...defaultProps} open={true} />);

      expect(screen.getByText("Generating share link...")).toBeInTheDocument();

      // Resolve the promise
      resolveShare!({ shareId: "test-id", shareDate: Date.now() });

      await waitFor(() => {
        expect(
          screen.queryByText("Generating share link..."),
        ).not.toBeInTheDocument();
      });
    });

    it("should not show social share buttons while loading", async () => {
      let resolveShare: (value: any) => void;
      const sharePromise = new Promise((resolve) => {
        resolveShare = resolve;
      });
      mockShareChat.mockReturnValue(sharePromise);

      render(<ShareDialog {...defaultProps} open={true} />);

      expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
      expect(screen.queryByText("X")).not.toBeInTheDocument();

      resolveShare!({ shareId: "test-id", shareDate: Date.now() });
    });
  });

  describe("Error Handling", () => {
    it("should show error message when share generation fails", async () => {
      mockShareChat.mockRejectedValue(new Error("Network error"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to generate share link. Please try again."),
        ).toBeInTheDocument();
      });
    });

    it("should show retry button on error", async () => {
      mockShareChat.mockRejectedValue(new Error("Network error"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Try again")).toBeInTheDocument();
      });
    });

    it("should retry share generation when retry button is clicked", async () => {
      mockShareChat
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          shareId: "success-id",
          shareDate: Date.now(),
        });

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Try again")).toBeInTheDocument();
      });

      const retryButton = screen.getByText("Try again");
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(mockShareChat).toHaveBeenCalledTimes(2);
      });

      await waitFor(() => {
        expect(
          screen.queryByText("Failed to generate share link. Please try again."),
        ).not.toBeInTheDocument();
      });
    });

    it("should not show social share buttons when error occurs", async () => {
      mockShareChat.mockRejectedValue(new Error("Network error"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Try again")).toBeInTheDocument();
      });

      expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
      expect(screen.queryByText("X")).not.toBeInTheDocument();
    });
  });

  describe("Social Share Buttons", () => {
    beforeEach(() => {
      mockShareChat.mockResolvedValue({
        shareId: "share123",
        shareDate: Date.now(),
      });
    });

    it("should copy link to clipboard when copy button is clicked", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Copy link")).toBeInTheDocument();
      });

      const copyButton = screen.getByText("Copy link").closest("button");
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalled();
        expect(mockWriteText.mock.calls[0][0]).toContain("/share/share123");
      });

      expect(mockToastSuccess).toHaveBeenCalledWith("Link copied to clipboard");
    });

    it("should show 'Copied!' text after successful copy", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Copy link")).toBeInTheDocument();
      });

      const copyButton = screen.getByText("Copy link").closest("button");
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(screen.getByText("Copied!")).toBeInTheDocument();
      });
    });

    it("should show error toast when copy fails", async () => {
      mockWriteText.mockRejectedValue(new Error("Copy failed"));

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Copy link")).toBeInTheDocument();
      });

      const copyButton = screen.getByText("Copy link").closest("button");
      fireEvent.click(copyButton!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Failed to copy link");
      });
    });

    it("should open X (Twitter) share window when X button is clicked", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("X")).toBeInTheDocument();
      });

      const xButton = screen.getByText("X").closest("button");
      fireEvent.click(xButton!);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("https://twitter.com/intent/tweet"),
        "_blank",
        "noopener,noreferrer",
      );
      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent("Test Chat Title")),
        "_blank",
        "noopener,noreferrer",
      );
    });

    it("should open LinkedIn share window when LinkedIn button is clicked", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("LinkedIn")).toBeInTheDocument();
      });

      const linkedInButton = screen.getByText("LinkedIn").closest("button");
      fireEvent.click(linkedInButton!);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("https://www.linkedin.com/sharing/share-offsite/"),
        "_blank",
        "noopener,noreferrer",
      );
    });

    it("should open Reddit share window when Reddit button is clicked", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Reddit")).toBeInTheDocument();
      });

      const redditButton = screen.getByText("Reddit").closest("button");
      fireEvent.click(redditButton!);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining("https://reddit.com/submit"),
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  describe("Preview Messages Display", () => {
    it("should fetch preview messages when dialog is open", async () => {
      mockUseQuery.mockReturnValue(mockPreviewMessages);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockUseQuery).toHaveBeenCalled();
      });

      // Check that the query was called with correct parameters (not "skip")
      const queryCall = mockUseQuery.mock.calls[0];
      expect(queryCall[1]).toEqual({ chatId: "test-chat-id" });
    });

    it("should not fetch preview messages when dialog is closed", () => {
      render(<ShareDialog {...defaultProps} open={false} />);

      // Query should be called with "skip"
      const queryCall = mockUseQuery.mock.calls[0];
      expect(queryCall[1]).toBe("skip");
    });

    it("should render user and assistant messages", async () => {
      mockUseQuery.mockReturnValue(mockPreviewMessages);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Hello, what is React?")).toBeInTheDocument();
      });

      expect(
        screen.getByText("React is a JavaScript library for building user interfaces."),
      ).toBeInTheDocument();
    });

    it("should render assistant messages using MemoizedMarkdown", async () => {
      mockUseQuery.mockReturnValue(mockPreviewMessages);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        const markdownContents = screen.getAllByTestId("markdown-content");
        expect(markdownContents.length).toBeGreaterThan(0);
      });
    });

    it("should render HackerAI logo in preview", async () => {
      mockUseQuery.mockReturnValue(mockPreviewMessages);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByTestId("hackerai-svg")).toBeInTheDocument();
      });
    });
  });

  describe("Dialog Close Behavior", () => {
    it("should call onOpenChange when close button is clicked", async () => {
      const mockOnOpenChange = jest.fn();

      render(
        <ShareDialog {...defaultProps} open={true} onOpenChange={mockOnOpenChange} />,
      );

      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });

    it("should reset states when dialog is reopened", async () => {
      const { rerender } = render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(screen.getByText("Copy link")).toBeInTheDocument();
      });

      // Close dialog
      rerender(<ShareDialog {...defaultProps} open={false} />);

      // Reopen dialog
      rerender(<ShareDialog {...defaultProps} open={true} />);

      // Should show loading state again (states reset)
      expect(screen.getByText("Generating share link...")).toBeInTheDocument();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty preview messages gracefully", async () => {
      mockUseQuery.mockReturnValue([]);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockShareChat).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.queryByText("Generating share link...")).not.toBeInTheDocument();
      });
    });

    it("should handle undefined preview messages", async () => {
      mockUseQuery.mockReturnValue(undefined);

      render(<ShareDialog {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockShareChat).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.queryByText("Generating share link...")).not.toBeInTheDocument();
      });
    });

    it("should handle very long chat titles", async () => {
      const longTitle = "A".repeat(200);

      render(<ShareDialog {...defaultProps} open={true} chatTitle={longTitle} />);

      expect(screen.getByText(longTitle)).toBeInTheDocument();
    });

    it("should handle special characters in chat title", async () => {
      const specialTitle = "Test <>&\"' Title";

      render(<ShareDialog {...defaultProps} open={true} chatTitle={specialTitle} />);

      expect(screen.getByText(specialTitle)).toBeInTheDocument();
    });

    it("should encode URL parameters correctly for social sharing", async () => {
      const titleWithSpecialChars = "Hello & Welcome!";

      render(
        <ShareDialog
          {...defaultProps}
          open={true}
          chatTitle={titleWithSpecialChars}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("X")).toBeInTheDocument();
      });

      const xButton = screen.getByText("X").closest("button");
      fireEvent.click(xButton!);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(titleWithSpecialChars)),
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  describe("Accessibility", () => {
    it("should have proper aria labels for buttons", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      expect(screen.getByLabelText("Close")).toBeInTheDocument();
    });

    it("should have accessible dialog description", async () => {
      render(<ShareDialog {...defaultProps} open={true} />);

      const description = screen.getByText(
        "Share this conversation via a public link",
      );
      expect(description).toHaveClass("sr-only");
    });
  });
});
