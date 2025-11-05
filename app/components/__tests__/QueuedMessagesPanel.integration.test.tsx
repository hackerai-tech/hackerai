import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import type { QueuedMessage } from "@/types/chat";

describe("QueuedMessagesPanel - Integration Tests", () => {
  const mockOnSendNow = jest.fn();
  const mockOnDelete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Panel Visibility", () => {
    it("should not render when messages array is empty", () => {
      const { container } = render(
        <QueuedMessagesPanel
          messages={[]}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={false}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it("should render when messages array has items", () => {
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Test message",
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("1 message queued")).toBeInTheDocument();
    });

    it("should display correct count for multiple messages", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
        { id: "msg-2", text: "Message 2", timestamp: Date.now() },
        { id: "msg-3", text: "Message 3", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("3 messages queued")).toBeInTheDocument();
    });
  });

  describe("Message Display", () => {
    it("should display message text preview", () => {
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "This is a test message",
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("This is a test message")).toBeInTheDocument();
    });

    it("should display file count when files are attached", () => {
      const mockFile = new File(["content"], "test.txt", {
        type: "text/plain",
      });
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Message with files",
          files: [
            { file: mockFile, fileId: "file-1", url: "https://example.com/1" },
            { file: mockFile, fileId: "file-2", url: "https://example.com/2" },
          ],
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("2 files")).toBeInTheDocument();
    });

    it("should display singular 'file' when only one file attached", () => {
      const mockFile = new File(["content"], "test.txt", {
        type: "text/plain",
      });
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Message with one file",
          files: [
            { file: mockFile, fileId: "file-1", url: "https://example.com/1" },
          ],
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("1 file")).toBeInTheDocument();
    });

    it("should display multiple messages in order", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "First message", timestamp: 1000 },
        { id: "msg-2", text: "Second message", timestamp: 2000 },
        { id: "msg-3", text: "Third message", timestamp: 3000 },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("First message")).toBeInTheDocument();
      expect(screen.getByText("Second message")).toBeInTheDocument();
      expect(screen.getByText("Third message")).toBeInTheDocument();
    });
  });

  describe("Send Now Button", () => {
    it("should render Send Now button for each message", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
        { id: "msg-2", text: "Message 2", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButtons = screen.getAllByText("Send Now");
      expect(sendButtons).toHaveLength(2);
    });

    it("should only remove the clicked message when Send Now is pressed", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "First message", timestamp: 1000 },
        { id: "msg-2", text: "Second message", timestamp: 2000 },
        { id: "msg-3", text: "Third message", timestamp: 3000 },
      ];

      const { rerender } = render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      // Click Send Now on the first message
      const sendButtons = screen.getAllByText("Send Now");
      fireEvent.click(sendButtons[0]); // Click first message's Send Now

      // Verify only msg-1 was sent
      expect(mockOnSendNow).toHaveBeenCalledTimes(1);
      expect(mockOnSendNow).toHaveBeenCalledWith("msg-1");

      // Simulate the message being removed from queue (only msg-1 should be removed)
      const remainingMessages = messages.filter((m) => m.id !== "msg-1");
      rerender(
        <QueuedMessagesPanel
          messages={remainingMessages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      // Should still show 2 messages (msg-2 and msg-3 should remain)
      expect(screen.getByText("2 messages queued")).toBeInTheDocument();
      expect(screen.getByText("Second message")).toBeInTheDocument();
      expect(screen.getByText("Third message")).toBeInTheDocument();
      expect(screen.queryByText("First message")).not.toBeInTheDocument();
    });

    it("should enable Send Now button when streaming", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButton = screen.getByText("Send Now");
      expect(sendButton).not.toBeDisabled();
    });

    it("should disable Send Now button when not streaming", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={false}
        />
      );

      const sendButton = screen.getByText("Send Now");
      expect(sendButton).toBeDisabled();
    });

    it("should call onSendNow with correct message ID when clicked", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-123", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButton = screen.getByText("Send Now");
      fireEvent.click(sendButton);

      expect(mockOnSendNow).toHaveBeenCalledTimes(1);
      expect(mockOnSendNow).toHaveBeenCalledWith("msg-123");
    });

    it("should call onSendNow with correct ID for multiple messages", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
        { id: "msg-2", text: "Message 2", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButtons = screen.getAllByText("Send Now");

      // Click second message's Send Now button
      fireEvent.click(sendButtons[1]);

      expect(mockOnSendNow).toHaveBeenCalledTimes(1);
      expect(mockOnSendNow).toHaveBeenCalledWith("msg-2");
    });

    it("should show correct title when streaming", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButton = screen.getByText("Send Now");
      expect(sendButton).toHaveAttribute(
        "title",
        "Cancel current response and send this now"
      );
    });

    it("should show correct title when not streaming", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={false}
        />
      );

      const sendButton = screen.getByText("Send Now");
      expect(sendButton).toHaveAttribute(
        "title",
        "Waiting for current response to complete"
      );
    });
  });

  describe("Delete Button", () => {
    it("should render delete button for each message", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
        { id: "msg-2", text: "Message 2", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const deleteButtons = screen.getAllByTitle("Remove from queue");
      expect(deleteButtons).toHaveLength(2);
    });

    it("should call onDelete with correct message ID when clicked", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-456", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const deleteButton = screen.getByTitle("Remove from queue");
      fireEvent.click(deleteButton);

      expect(mockOnDelete).toHaveBeenCalledTimes(1);
      expect(mockOnDelete).toHaveBeenCalledWith("msg-456");
    });

    it("should call onDelete with correct ID for multiple messages", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
        { id: "msg-2", text: "Message 2", timestamp: Date.now() },
        { id: "msg-3", text: "Message 3", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const deleteButtons = screen.getAllByTitle("Remove from queue");

      // Click third message's delete button
      fireEvent.click(deleteButtons[2]);

      expect(mockOnDelete).toHaveBeenCalledTimes(1);
      expect(mockOnDelete).toHaveBeenCalledWith("msg-3");
    });

    it("should allow deleting when not streaming", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={false}
        />
      );

      const deleteButton = screen.getByTitle("Remove from queue");
      expect(deleteButton).not.toBeDisabled();

      fireEvent.click(deleteButton);
      expect(mockOnDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle messages with both text and files", () => {
      const mockFile = new File(["content"], "test.txt", {
        type: "text/plain",
      });
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Check out these files",
          files: [
            { file: mockFile, fileId: "file-1", url: "https://example.com/1" },
            { file: mockFile, fileId: "file-2", url: "https://example.com/2" },
            { file: mockFile, fileId: "file-3", url: "https://example.com/3" },
          ],
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("Check out these files")).toBeInTheDocument();
      expect(screen.getByText("3 files")).toBeInTheDocument();
      expect(screen.getByText("Send Now")).toBeInTheDocument();
      expect(screen.getByTitle("Remove from queue")).toBeInTheDocument();
    });

    it("should handle long message text with truncation", () => {
      const longText = "This is a very long message that should be truncated when displayed in the queue panel UI to prevent layout issues";
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: longText,
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText(longText)).toBeInTheDocument();
    });

    it("should maintain state across streaming transitions", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Message 1", timestamp: Date.now() },
      ];

      const { rerender } = render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("Send Now")).not.toBeDisabled();

      // Transition to not streaming
      rerender(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={false}
        />
      );

      expect(screen.getByText("Send Now")).toBeDisabled();

      // Transition back to streaming
      rerender(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("Send Now")).not.toBeDisabled();
    });

    it("should handle rapid button clicks gracefully", () => {
      const messages: QueuedMessage[] = [
        { id: "msg-1", text: "Test message", timestamp: Date.now() },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      const sendButton = screen.getByText("Send Now");

      // Click multiple times rapidly
      fireEvent.click(sendButton);
      fireEvent.click(sendButton);
      fireEvent.click(sendButton);

      // Should call handler for each click
      expect(mockOnSendNow).toHaveBeenCalledTimes(3);
    });
  });

  describe("Edge Cases", () => {
    it("should handle message with empty text", () => {
      const mockFile = new File(["content"], "test.txt", {
        type: "text/plain",
      });
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "",
          files: [
            { file: mockFile, fileId: "file-1", url: "https://example.com/1" },
          ],
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      // Should still render the panel with file info
      expect(screen.getByText("1 file")).toBeInTheDocument();
    });

    it("should handle message with undefined files", () => {
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Test message",
          files: undefined,
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("Test message")).toBeInTheDocument();
      // Should not show file count
      expect(screen.queryByText(/file/)).not.toBeInTheDocument();
    });

    it("should handle message with empty files array", () => {
      const messages: QueuedMessage[] = [
        {
          id: "msg-1",
          text: "Test message",
          files: [],
          timestamp: Date.now(),
        },
      ];

      render(
        <QueuedMessagesPanel
          messages={messages}
          onSendNow={mockOnSendNow}
          onDelete={mockOnDelete}
          isStreaming={true}
        />
      );

      expect(screen.getByText("Test message")).toBeInTheDocument();
      // Should not show file count for empty array
      expect(screen.queryByText(/file/)).not.toBeInTheDocument();
    });
  });
});
