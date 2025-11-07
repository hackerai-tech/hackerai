import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach, beforeAll } from "@jest/globals";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDialog } from "../ShareDialog";
import { toast } from "sonner";

// Mock sonner
jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock Convex hooks
const mockShareChat = jest.fn();
const mockUpdateShareDate = jest.fn();
const mockUnshareChat = jest.fn();

jest.mock("convex/react", () => ({
  useMutation: (mutationFn: any) => {
    const fnStr = mutationFn.toString();
    if (fnStr.includes("shareChat")) return mockShareChat;
    if (fnStr.includes("updateShareDate")) return mockUpdateShareDate;
    if (fnStr.includes("unshareChat")) return mockUnshareChat;
    return jest.fn();
  },
}));

describe("ShareDialog", () => {
  const mockOnOpenChange = jest.fn();
  const defaultProps = {
    open: true,
    onOpenChange: mockOnOpenChange,
    chatId: "test-chat-id",
    chatTitle: "Test Chat Title",
  };

  beforeAll(() => {
    // Mock clipboard API
    const mockWriteText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    });

    // Mock window.open
    (global as any).open = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockShareChat.mockResolvedValue({
      shareId: "test-share-id",
      shareDate: Date.now(),
    });
    mockUpdateShareDate.mockResolvedValue({
      shareId: "test-share-id",
      shareDate: Date.now(),
    });
    mockUnshareChat.mockResolvedValue(undefined);
  });

  describe("Basic Rendering", () => {
    it("should render dialog when open", () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByText("Share chat")).toBeInTheDocument();
    });

    it("should display chat title being shared", () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByText("Test Chat Title")).toBeInTheDocument();
    });

    it("should show create button when not shared yet", () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByText("Create Share Link")).toBeInTheDocument();
    });
  });

  describe("Creating Share", () => {
    it("should show loading state while generating", async () => {
      mockShareChat.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(<ShareDialog {...defaultProps} />);
      const createButton = screen.getByText("Create Share Link");
      fireEvent.click(createButton);

      expect(screen.getByText("Generating share link...")).toBeInTheDocument();
    });

    it("should show error message on creation failure", async () => {
      mockShareChat.mockRejectedValue(new Error("Failed to share"));

      render(<ShareDialog {...defaultProps} />);
      const createButton = screen.getByText("Create Share Link");
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(
          screen.getByText("Failed to generate share link. Please try again.")
        ).toBeInTheDocument();
      });
    });
  });

  describe("Existing Share", () => {
    it("should show share URL when already shared", () => {
      const existingShareId = "existing-share-id";
      render(<ShareDialog {...defaultProps} existingShareId={existingShareId} />);

      const input = screen.getByDisplayValue(
        new RegExp(`/share/${existingShareId}`)
      );
      expect(input).toBeInTheDocument();
    });
  });

  describe("Share Date Formatting", () => {
    it("should format recent share date in minutes", () => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      render(
        <ShareDialog
          {...defaultProps}
          existingShareId="test-id"
          existingShareDate={fiveMinutesAgo}
        />
      );

      expect(screen.getByText(/5 minutes ago/)).toBeInTheDocument();
    });

    it("should format share date in hours", () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

      render(
        <ShareDialog
          {...defaultProps}
          existingShareId="test-id"
          existingShareDate={twoHoursAgo}
        />
      );

      expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
    });
  });
});
