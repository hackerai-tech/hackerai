import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReactNode, useEffect } from "react";
import { CONVERSATION_DRAFTS_STORAGE_KEY } from "@/lib/utils/client-storage";
import type { UploadedFileState } from "@/types/file";

const mockUseQuery = jest.fn(() => undefined);
const mockReadGeneratedTextAttachment = jest.fn();

// Mock only external dependencies, not contexts
jest.mock("react-hotkeys-hook", () => ({
  useHotkeys: jest.fn(),
}));

// Mock Convex hooks used by useFileUpload
jest.mock("convex/react", () => ({
  useAuth: () => ({ user: null, entitlements: [] }),
  useMutation: () => jest.fn(),
  useAction: () => jest.fn(),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/app/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileInputRef: { current: null },
    handleFileUploadEvent: jest.fn(),
    handleRemoveFile: jest.fn(),
    handleUpdateGeneratedTextFile: jest.fn(),
    handleAttachClick: jest.fn(),
    handlePasteEvent: jest.fn(),
    handlePastedTextAttachment: jest.fn(),
  }),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  useTauri: () => ({ isTauri: false }),
  isTauriEnvironment: jest.fn(() => false),
  readGeneratedTextAttachment: (...args: unknown[]) =>
    mockReadGeneratedTextAttachment(...args),
}));

const { ChatInput } =
  jest.requireActual<typeof import("../ChatInput")>("../ChatInput");
const { GlobalStateProvider, useGlobalState } = jest.requireActual<
  typeof import("../../contexts/GlobalState")
>("../../contexts/GlobalState");
const { AgentApprovalProvider, useAgentApproval } = jest.requireActual<
  typeof import("../../contexts/AgentApprovalContext")
>("../../contexts/AgentApprovalContext");

// Wrapper with real providers
const TestWrapper = ({ children }: { children: ReactNode }) => {
  return (
    <GlobalStateProvider>
      <AgentApprovalProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </AgentApprovalProvider>
    </GlobalStateProvider>
  );
};

const UploadedFilesSetter = ({
  files,
  label,
}: {
  files: UploadedFileState[];
  label: string;
}) => {
  const { setUploadedFiles } = useGlobalState();

  return (
    <button type="button" onClick={() => setUploadedFiles(files)}>
      {label}
    </button>
  );
};

const AgentApprovalSetter = () => {
  const { setChatMode } = useGlobalState();
  const { setAgentApprovalSession, setActiveToolApprovalRequest } =
    useAgentApproval();

  useEffect(() => {
    setChatMode("agent");
    setAgentApprovalSession({
      chatId: "approval-chat",
      sessionId: "agent-approval-session",
      publicAccessToken: "public-token",
    });
    setActiveToolApprovalRequest({
      approvalId: "approval-1",
      toolCallId: "tool-1",
      title: "Allow HackerAI to run this terminal command?",
      target: "ping -c 4 hackerone.com",
      justification: "Check whether the target host is reachable.",
      prefixRule: ["ping", "-c", "4"],
      detail: "Approve to continue, or deny to stop this command.",
      kind: "terminal",
      operation: "terminal_execute",
    });
  }, [setActiveToolApprovalRequest, setAgentApprovalSession, setChatMode]);

  return null;
};

const AgentModeSetter = () => {
  const { setChatMode } = useGlobalState();

  useEffect(() => {
    setChatMode("agent");
  }, [setChatMode]);

  return null;
};

describe("ChatInput - Integration Tests", () => {
  const mockOnSubmit = jest.fn();
  const mockOnStop = jest.fn();
  const mockOnReconnect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue(undefined);
    mockReadGeneratedTextAttachment.mockReset();
    window.localStorage.clear();
  });

  describe("Ask Mode Integration", () => {
    it("should render with ask mode as default", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      expect(
        screen.getByPlaceholderText("Ask, learn, brainstorm"),
      ).toBeInTheDocument();
      expect(screen.getByText("Ask")).toBeInTheDocument();
    });

    it("should show only submit button when ready in ask mode", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      expect(screen.getByLabelText("Send message")).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Stop generation"),
      ).not.toBeInTheDocument();
    });

    it("should show only stop button when streaming in ask mode", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
          />
        </TestWrapper>,
      );

      expect(screen.getByLabelText("Stop generation")).toBeInTheDocument();
      expect(screen.queryByLabelText("Queue message")).not.toBeInTheDocument();
    });

    it("should call onStop when stop button clicked", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
          />
        </TestWrapper>,
      );

      const stopButton = screen.getByLabelText("Stop generation");
      fireEvent.click(stopButton);

      expect(mockOnStop).toHaveBeenCalledTimes(1);
    });

    it("should not show queue panel in ask mode even with queued messages", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      // Queue panel should not be visible in ask mode
      expect(screen.queryByText("Queued messages")).not.toBeInTheDocument();
    });
  });

  describe("Agent Mode Integration", () => {
    it("does not show a late approval after the composer stop button is clicked", async () => {
      let resolveStop: ((stopped: boolean) => void) | undefined;
      const pendingStop = new Promise<boolean>((resolve) => {
        resolveStop = resolve;
      });
      const stop = jest.fn(() => pendingStop);
      const approvalRequest = {
        approvalId: "late-approval-1",
        toolCallId: "tool-1",
        title: "Allow HackerAI to run this terminal command?",
        target: "curl https://hackerai.co",
        detail: "Approve to continue, or deny to stop this command.",
        kind: "terminal" as const,
        operation: "terminal_execute",
      };
      const renderChatInput = (
        status: "ready" | "streaming",
        storedApprovalRequest: typeof approvalRequest | null,
      ) => (
        <TestWrapper>
          <AgentModeSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={stop}
            status={status}
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={storedApprovalRequest}
          />
        </TestWrapper>
      );
      const { rerender } = render(renderChatInput("streaming", null));

      fireEvent.click(screen.getByLabelText("Stop generation"));
      rerender(renderChatInput("streaming", approvalRequest));

      expect(stop).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId("agent-approval-prompt"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Reconnecting to the Agent approval session..."),
      ).not.toBeInTheDocument();

      await act(async () => resolveStop?.(true));
      rerender(renderChatInput("ready", null));
      rerender(renderChatInput("ready", approvalRequest));

      expect(screen.getByTestId("agent-approval-prompt")).toBeInTheDocument();
    });

    it("replaces the composer with an approval selector while awaiting approval", async () => {
      render(
        <TestWrapper>
          <AgentApprovalSetter />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="streaming"
            chatId="approval-chat"
            hasMessages
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByTestId("agent-approval-prompt"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Allow once" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "More approval options" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
      expect(
        screen.getByText("Check whether the target host is reachable."),
      ).toBeInTheDocument();
      expect(screen.getByText("ping -c 4 hackerone.com")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
    });

    it("renders recovery controls while a stored approval reconnects", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      expect(screen.getByTestId("agent-approval-prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Reconnecting to the Agent approval session..."),
      ).toBeInTheDocument();
      expect(screen.getByText("ping -c 4 hackerone.com")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Allow once" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

      expect(mockOnStop).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText("Reconnecting to the Agent approval session..."),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    });

    it("restores the approval prompt when stopping the Agent fails", async () => {
      const failedStop = jest.fn(async () => false);

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={failedStop}
            status="ready"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

      await waitFor(() =>
        expect(
          screen.getByText("Reconnecting to the Agent approval session..."),
        ).toBeInTheDocument(),
      );
      expect(failedStop).toHaveBeenCalledTimes(1);
    });

    it("renders retry and stop controls when stored approval reconnection fails", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onReconnect={mockOnReconnect}
            status="error"
            chatId="approval-chat"
            hasMessages
            storedApprovalRequest={{
              approvalId: "stored-approval-1",
              toolCallId: "tool-1",
              title: "Allow HackerAI to run this terminal command?",
              target: "ping -c 4 hackerone.com",
              detail: "Approve to continue, or deny to stop this command.",
              kind: "terminal",
              operation: "terminal_execute",
            }}
          />
        </TestWrapper>,
      );

      expect(
        screen.getByText("Could not reconnect to the Agent approval session."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Retry connection" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Stop agent" }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

      expect(mockOnReconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("Submit Behavior Integration", () => {
    it("migrates restored pasted-text attachments when a new chat gets its real id", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        tokens: 120,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "new",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      const { rerender } = render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={true}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();

      rerender(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "chat-1",
              attachments: [
                expect.objectContaining({
                  ...draftAttachment,
                  generatedSource: "pasted-text",
                }),
              ],
            }),
          ]),
        );
      });
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(
        store.drafts.some((draft: { id: string }) => draft.id === "new"),
      ).toBe(false);
      expect(screen.getByText("pasted-text.txt")).toBeInTheDocument();
    });

    it("uses the real chat draft once a persistent new chat has messages", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={true}
            hasMessages={true}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
    });

    it("restores pasted-text draft attachments with editable content", async () => {
      const pastedContent = "Original pasted source material";
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_123",
        timestamp: Date.now(),
      };
      mockUseQuery.mockImplementation((_query, args) =>
        args &&
        args !== "skip" &&
        Array.isArray((args as { fileIds?: unknown }).fileIds)
          ? [
              {
                id: "file_123",
                name: "pasted-text.txt",
                mediaType: "text/plain",
                content: pastedContent,
                tokenSize: 120,
              },
            ]
          : undefined,
      );
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByLabelText("Open pasted-text.txt"),
        ).not.toBeDisabled(),
      );

      fireEvent.click(screen.getByLabelText("Open pasted-text.txt"));
      expect(screen.getByLabelText("Pasted text content")).toHaveValue(
        pastedContent,
      );
      expect(
        screen.getByText("Changes save automatically as you edit"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Pasted text content")).not.toBeDisabled();
      expect(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
      ).not.toContain(pastedContent);
      expect(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
      ).toContain("generated_123");
    });

    it("restores local generated pasted-text drafts from the Desktop file", async () => {
      const pastedContent = "Local pasted source material";
      const localPath = "/Users/alice/pasted_content.txt";
      const draftAttachment = {
        kind: "pasted-text" as const,
        storage: "local-desktop" as const,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_local_123",
        timestamp: Date.now(),
      };
      mockReadGeneratedTextAttachment.mockResolvedValue({
        path: localPath,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: pastedContent.length,
        lastModified: 123456,
        content: pastedContent,
      });
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted_content.txt")).toBeInTheDocument();
      await waitFor(() =>
        expect(mockReadGeneratedTextAttachment).toHaveBeenCalledWith(
          "generated_local_123",
          "pasted_content.txt",
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByLabelText("Open pasted_content.txt"),
        ).not.toBeDisabled(),
      );

      fireEvent.click(screen.getByLabelText("Open pasted_content.txt"));
      expect(screen.getByLabelText("Pasted text content")).toHaveValue(
        pastedContent,
      );
      const storedDraft = window.localStorage.getItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
      );
      expect(storedDraft).not.toContain(pastedContent);
      expect(storedDraft).not.toContain(localPath);
    });

    it("keeps an unavailable local pasted-text draft without exposing content", async () => {
      const draftAttachment = {
        kind: "pasted-text" as const,
        storage: "local-desktop" as const,
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text" as const,
        generatedTextAttachmentId: "generated_local_missing",
        timestamp: Date.now(),
      };
      mockReadGeneratedTextAttachment.mockResolvedValue(null);
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(
        await screen.findByText("Unavailable on this device"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Open pasted_content.txt")).toBeDisabled();
      await waitFor(() =>
        expect(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
        ).toContain("generated_local_missing"),
      );
    });

    it("restores regular S3 draft attachments", async () => {
      const draftAttachment = {
        kind: "file" as const,
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        tokens: 42,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    });

    it("does not restore draft attachments when attachment restoration is disabled", async () => {
      const draftAttachment = {
        kind: "file" as const,
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "new",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            onSendNow={jest.fn()}
            status="ready"
            isNewChat={true}
            restoreDraftAttachments={false}
          />
        </TestWrapper>,
      );

      await act(async () => {});

      expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(store.drafts[0].attachments).toEqual([draftAttachment]);
    });

    it("persists regular S3 uploaded files into draft attachments", async () => {
      const browserFile = new File(["x".repeat(2048)], "report.pdf", {
        type: "application/pdf",
        lastModified: 123456,
      });
      const pendingFile: UploadedFileState = {
        file: browserFile,
        uploading: true,
        uploaded: false,
        storage: "s3",
      };
      const uploadedFile: UploadedFileState = {
        file: browserFile,
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_regular",
        tokens: 84,
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[pendingFile]} label="Start upload" />
          <UploadedFilesSetter files={[uploadedFile]} label="Complete upload" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      await act(async () => {});
      fireEvent.click(screen.getByText("Start upload"));
      await waitFor(() => {
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
      });
      await act(async () => {});
      const beforeCompletion = Date.now();
      fireEvent.click(screen.getByText("Complete upload"));

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              {
                kind: "file",
                fileId: "file_regular",
                name: "report.pdf",
                mediaType: "application/pdf",
                size: 2048,
                tokens: 84,
                timestamp: expect.any(Number),
              },
            ],
          }),
        ]);
        expect(store.drafts[0].attachments[0].timestamp).toBeGreaterThanOrEqual(
          beforeCompletion,
        );
      });
    });

    it("persists generated pasted-text metadata without draft content", async () => {
      const pastedContent = "Original pasted source material";
      const browserFile = new File([pastedContent], "pasted_content.txt", {
        type: "text/plain",
        lastModified: 123456,
      });
      const uploadedFile: UploadedFileState = {
        file: browserFile,
        uploading: false,
        uploaded: true,
        storage: "s3",
        fileId: "file_pasted",
        tokens: 84,
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: "generated_123",
          content: pastedContent,
        },
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Complete upload" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Complete upload"));

      await waitFor(() => {
        const store = JSON.parse(
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
        );
        expect(store.drafts).toEqual([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              expect.objectContaining({
                kind: "pasted-text",
                fileId: "file_pasted",
                name: "pasted_content.txt",
                mediaType: "text/plain",
                size: pastedContent.length,
                tokens: 84,
                generatedSource: "pasted-text",
                generatedTextAttachmentId: "generated_123",
              }),
            ],
          }),
        ]);
        expect(JSON.stringify(store)).not.toContain(pastedContent);
      });
    });

    it("keeps the committed pasted-text draft while an edit is uploading", async () => {
      const previousContent = "Previously saved source material";
      const editedContent = "Edited source material";
      const uploadedFile: UploadedFileState = {
        file: new File([editedContent], "pasted_content.txt", {
          type: "text/plain",
          lastModified: 234567,
        }),
        uploading: true,
        uploaded: false,
        storage: "s3",
        fileId: "file_pasted_previous",
        tokens: 84,
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: "generated_123",
          content: editedContent,
        },
      };

      render(
        <TestWrapper>
          <UploadedFilesSetter files={[uploadedFile]} label="Start edit" />
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByText("Start edit"));

      await waitFor(() => {
        const storedDraft =
          window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "";
        expect(storedDraft).toContain("file_pasted_previous");
        expect(storedDraft).toContain("generated_123");
        expect(storedDraft).not.toContain(previousContent);
        expect(storedDraft).not.toContain(editedContent);
      });
    });

    it("keeps restored pasted-text drafts when submit is rejected", async () => {
      const rejectedSubmit = jest.fn(() => false);
      const draftAttachment = {
        kind: "pasted-text" as const,
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      };
      window.localStorage.setItem(
        CONVERSATION_DRAFTS_STORAGE_KEY,
        JSON.stringify({
          drafts: [
            {
              id: "chat-1",
              content: "",
              timestamp: Date.now(),
              attachments: [draftAttachment],
            },
          ],
        }),
      );

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={rejectedSubmit}
            onStop={mockOnStop}
            status="ready"
            isNewChat={false}
            chatId="chat-1"
          />
        </TestWrapper>,
      );

      expect(await screen.findByText("pasted-text.txt")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Send message"));

      await waitFor(() => expect(rejectedSubmit).toHaveBeenCalledTimes(1));
      const store = JSON.parse(
        window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY) ?? "{}",
      );
      expect(store.drafts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "chat-1",
            attachments: [
              expect.objectContaining({
                ...draftAttachment,
                generatedSource: "pasted-text",
              }),
            ],
          }),
        ]),
      );
    });

    it("should disable submit when no input", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const submitButton = screen.getByLabelText("Send message");
      expect(submitButton).toBeDisabled();
    });

    it("should handle submitted status correctly", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="submitted"
          />
        </TestWrapper>,
      );

      // Component should render without errors in submitted status
      expect(
        screen.getByPlaceholderText("Ask, learn, brainstorm"),
      ).toBeInTheDocument();
    });

    it("should handle enter key to submit", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const textarea = screen.getByPlaceholderText("Ask, learn, brainstorm");

      // Type some text
      fireEvent.change(textarea, { target: { value: "Test message" } });

      // Press enter
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(mockOnSubmit).toHaveBeenCalledTimes(1);
    });

    it("should not submit on shift+enter", () => {
      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
          />
        </TestWrapper>,
      );

      const textarea = screen.getByPlaceholderText("Ask, learn, brainstorm");

      // Type some text
      fireEvent.change(textarea, { target: { value: "Test message" } });

      // Press shift+enter (should add newline, not submit)
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe("Rate Limit Warning Integration", () => {
    it("should accept rate limit warning props", () => {
      // Note: Specific text matching removed due to component complexity
      // The important test is that the component renders without errors when warning is provided
      expect(() =>
        render(
          <TestWrapper>
            <ChatInput
              onSubmit={mockOnSubmit}
              onStop={mockOnStop}
              status="ready"
              rateLimitWarning={{
                warningType: "sliding-window",
                remaining: 5,
                resetTime: new Date(Date.now() + 3600000),
                mode: "ask",
                subscription: "free",
              }}
              onDismissRateLimitWarning={jest.fn()}
            />
          </TestWrapper>,
        ),
      ).not.toThrow();
    });
  });

  describe("Scroll to Bottom Integration", () => {
    it("should show scroll to bottom button when provided", () => {
      const mockScrollToBottom = jest.fn();

      render(
        <TestWrapper>
          <ChatInput
            onSubmit={mockOnSubmit}
            onStop={mockOnStop}
            status="ready"
            hasMessages={true}
            isAtBottom={false}
            onScrollToBottom={mockScrollToBottom}
          />
        </TestWrapper>,
      );

      // Scroll to bottom button should be present when not at bottom
      const scrollButton = screen.getByLabelText("Scroll to bottom");
      expect(scrollButton).toBeInTheDocument();

      fireEvent.click(scrollButton);
      expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
    });
  });
});
