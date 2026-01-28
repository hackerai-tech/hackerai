import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { SharedMessages } from "../SharedMessages";
import { SharedChatProvider } from "../SharedChatContext";

// Wrapper component to provide context
const renderWithContext = (ui: React.ReactElement) => {
  return render(<SharedChatProvider>{ui}</SharedChatProvider>);
};

describe("SharedMessages", () => {
  const mockShareDate = Date.now();

  describe("Empty State", () => {
    it("should show empty message when no messages provided", () => {
      renderWithContext(
        <SharedMessages messages={[]} shareDate={mockShareDate} />,
      );
      expect(
        screen.getByText("No messages in this conversation"),
      ).toBeInTheDocument();
    });
  });

  describe("Shared Conversation Notice", () => {
    it("should display shared conversation notice", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [{ type: "text", text: "Hello" }],
          update_time: mockShareDate - 1000,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(
        screen.getByText(
          "This is a copy of a conversation between HackerAI & Anonymous.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("Text Messages", () => {
    it("should render user text message", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [{ type: "text", text: "Hello, this is a test message" }],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(
        screen.getByText("Hello, this is a test message"),
      ).toBeInTheDocument();
    });

    it("should render assistant text message", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [{ type: "text", text: "I can help you with that" }],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("I can help you with that")).toBeInTheDocument();
    });

    it("should render multiple messages", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [{ type: "text", text: "First message" }],
          update_time: mockShareDate - 2000,
        },
        {
          id: "2",
          role: "assistant" as const,
          parts: [{ type: "text", text: "Second message" }],
          update_time: mockShareDate - 1000,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("First message")).toBeInTheDocument();
      expect(screen.getByText("Second message")).toBeInTheDocument();
    });
  });

  describe("File and Image Placeholders", () => {
    it("should show placeholder for uploaded file", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [{ type: "file", placeholder: true }],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Uploaded a file")).toBeInTheDocument();
    });

    it("should show placeholder for uploaded image", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [{ type: "image", placeholder: true }],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Uploaded an image")).toBeInTheDocument();
    });
  });

  describe("Tool Execution - Terminal Commands", () => {
    it("should render terminal command tool block", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-run_terminal_cmd",
              state: "output-available",
              input: { command: "ls -la" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Executed")).toBeInTheDocument();
      expect(screen.getByText("ls -la")).toBeInTheDocument();
    });
  });

  describe("Tool Execution - File Operations", () => {
    it("should render read file operation", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-read_file",
              state: "output-available",
              input: { file_path: "/path/to/file.txt" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText("/path/to/file.txt")).toBeInTheDocument();
    });

    it("should render write file operation", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-write_file",
              state: "output-available",
              input: { file_path: "/path/to/new-file.js" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Successfully wrote")).toBeInTheDocument();
      expect(screen.getByText("/path/to/new-file.js")).toBeInTheDocument();
    });

    it("should render edit file operation", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-search_replace",
              state: "output-available",
              input: { file_path: "/path/to/edited.ts" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Successfully edited")).toBeInTheDocument();
      expect(screen.getByText("/path/to/edited.ts")).toBeInTheDocument();
    });
  });

  describe("Tool Execution - Python", () => {
    it("should render Python execution tool block", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-python",
              state: "output-available",
              input: { code: "print('Hello World')" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Executed Python")).toBeInTheDocument();
      expect(screen.getByText("print('Hello World')")).toBeInTheDocument();
    });
  });

  describe("Tool Execution - Web Search", () => {
    it("should render web search tool block", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-web_search",
              state: "output-available",
              input: { query: "best practices for testing" },
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Searched web")).toBeInTheDocument();
      expect(
        screen.getByText("best practices for testing"),
      ).toBeInTheDocument();
    });
  });

  describe("Tool Execution - Todo and Memory", () => {
    it("should render todo update tool block", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-todo_write",
              state: "output-available",
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Updated todos")).toBeInTheDocument();
    });

    it("should render memory update tool block", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-update_memory",
              state: "output-available",
            },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("Updated memory")).toBeInTheDocument();
    });
  });

  // Message count summary moved to SharedChatView footer

  describe("Complex Message Parts", () => {
    it("should render message with multiple parts", () => {
      const messages = [
        {
          id: "1",
          role: "assistant" as const,
          parts: [
            { type: "text", text: "I'll help you with that." },
            {
              type: "tool-read_file",
              state: "output-available",
              input: { file_path: "/test.js" },
            },
            { type: "text", text: "Here's what I found." },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(screen.getByText("I'll help you with that.")).toBeInTheDocument();
      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText("Here's what I found.")).toBeInTheDocument();
    });

    it("should handle messages with text and file placeholders", () => {
      const messages = [
        {
          id: "1",
          role: "user" as const,
          parts: [
            { type: "text", text: "Here's the document you requested" },
            { type: "file", placeholder: true },
          ],
          update_time: mockShareDate,
        },
      ];

      renderWithContext(
        <SharedMessages messages={messages} shareDate={mockShareDate} />,
      );
      expect(
        screen.getByText("Here's the document you requested"),
      ).toBeInTheDocument();
      expect(screen.getByText("Uploaded a file")).toBeInTheDocument();
    });
  });
});
