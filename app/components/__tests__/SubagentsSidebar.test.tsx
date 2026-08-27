import "@testing-library/jest-dom";
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockUseQuery = jest.fn<any>();
const mockSetMessageFeedback = jest.fn<any>();
const mockUseSubagentRealtime = jest.fn<any>();
jest.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => mockSetMessageFeedback,
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subagents: {
      listForParentMessage: "listForParentMessage",
      getOwned: "getOwned",
      getMessagesOwned: "getMessagesOwned",
      setMessageFeedback: "setMessageFeedback",
    },
  },
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/app/hooks/useSubagentRealtime", () => ({
  useSubagentRealtime: (...args: unknown[]) => mockUseSubagentRealtime(...args),
}));

const captureAuthenticatedEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) =>
    captureAuthenticatedEvent(...args),
}));

jest.mock("../MessagePartHandler", () => ({
  MessagePartHandler: ({
    keepLatestReasoningOpenDuringStreaming,
    part,
  }: {
    keepLatestReasoningOpenDuringStreaming?: boolean;
    part: { text?: string; type: string };
  }) => (
    <div
      data-testid={`part-${part.type}`}
      data-keep-latest-reasoning-open={
        keepLatestReasoningOpenDuringStreaming ? "true" : "false"
      }
    >
      {part.text}
    </div>
  ),
}));

const { SubagentsSidebar } =
  require("../SubagentsSidebar") as typeof import("../SubagentsSidebar");

const activeChild = {
  subagent_id: "sa_active",
  parent_message_id: "parent-message",
  parent_trigger_run_id: "parent-run",
  parent_tool_call_id: "tool-1",
  trigger_run_id: "child-run",
  profile: "security_validation",
  status: "running",
  objective: "Inspect profile rendering for script injection.",
  title: "Active candidate",
  subtitle: "https://example.test/profile",
  candidate: {
    title: "Active candidate",
    affected_asset: "https://example.test/profile",
  },
  created_at: Date.now() - 5_000,
  started_at: Date.now() - 4_000,
};

const doneChild = {
  ...activeChild,
  subagent_id: "sa_done",
  trigger_run_id: "child-run-done",
  status: "completed",
  verdict: "rejected",
  summary: "The supplied proof did not reproduce.",
  objective: "Reproduce the supplied search-page behavior independently.",
  title: "Rejected candidate",
  subtitle: "https://example.test/search",
  candidate: {
    title: "Rejected candidate",
    affected_asset: "https://example.test/search",
  },
  completed_at: Date.now() - 1_000,
};

const canceledChild = {
  ...activeChild,
  subagent_id: "sa_canceled",
  trigger_run_id: "child-run-canceled",
  status: "canceled",
  summary: "Subagent was canceled.",
  cancel_reason: "parent_requested",
  objective: "Check whether the target reflects the supplied marker.",
  title: "Canceled candidate",
  completed_at: Date.now() - 1_000,
};

const skilledTaskChild = {
  ...activeChild,
  subagent_id: "sa_skilled_task",
  profile: "security_task",
  title: "Authorization specialist",
  objective: "Inspect object-level authorization boundaries.",
  skills: ["vulnerabilities/idor", "analysis/source_aware_discovery"],
};

const persistedAssistantCreatedAt = Date.now() - 60_000;

describe("SubagentsSidebar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMessageFeedback.mockResolvedValue("updated");
    mockUseSubagentRealtime.mockImplementation(
      ({ enabled }: { enabled: boolean }) => ({
        message: null,
        state: enabled ? "connecting" : "idle",
        retry: jest.fn(),
      }),
    );
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [activeChild, doneChild];
      if (query === "getOwned") {
        return args === "skip"
          ? undefined
          : ([activeChild, doneChild].find(
              (child) => child.subagent_id === args?.subagentId,
            ) ?? null);
      }
      return [
        {
          message_id: "subagent-message-0",
          sequence: 0,
          role: "user",
          parts: [
            {
              type: "text",
              text: "Internal worker prompt that should not be displayed",
            },
          ],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        {
          message_id: "subagent-message-1",
          sequence: 1,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "The validation is complete. The finding is **rejected** with high confidence.",
            },
            { type: "text", text: "The candidate does not reproduce." },
          ],
          created_at: persistedAssistantCreatedAt,
          updated_at: Date.now(),
        },
      ];
    });
  });

  it("groups active and done children, then opens a live child detail", () => {
    const closeSidebar = jest.fn();
    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
        }}
        closeSidebar={closeSidebar}
      />,
    );

    expect(screen.getByRole("heading", { name: "Active · 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Done · 1" })).toBeVisible();
    expect(screen.getByText("Active candidate")).toBeVisible();
    expect(screen.getByText("Rejected candidate")).toBeVisible();
    expect(screen.getByText("https://example.test/profile")).toBeVisible();
    expect(
      screen.getByText("The supplied proof did not reproduce."),
    ).toBeVisible();
    expect(screen.getByText("Working")).toBeVisible();
    expect(screen.getByText("Rejected")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Active candidate, Working/i,
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Active candidate" }),
    ).toBeVisible();
    expect(
      screen.getByText("Inspect profile rendering for script injection."),
    ).toBeVisible();
    expect(screen.getByText("Task")).toBeVisible();
    expect(screen.getByText("Subagent")).toBeVisible();
    expect(
      screen.queryByText("Internal worker prompt that should not be displayed"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_opened",
      expect.objectContaining({ subagent_id: "sa_active" }),
    );
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_transcript_resolved",
      expect.objectContaining({
        subagent_id: "sa_active",
        source: "persisted",
        has_activity: true,
        activity_message_count: 1,
      }),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible();
    expect(closeSidebar).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSidebar).toHaveBeenCalledTimes(1);
  });

  it("shows assigned specialist skills only in the opened child details", () => {
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [skilledTaskChild];
      if (query === "getOwned") {
        return args === "skip" ? undefined : skilledTaskChild;
      }
      return [];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(screen.queryByLabelText("Assigned skills")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Authorization specialist, Working/i,
      }),
    );

    const skills = screen.getByLabelText("Assigned skills");
    expect(skills).toHaveTextContent("Skills · 2");
    const idorSkill = screen.getByText("IDOR");
    expect(idorSkill).toBeVisible();
    expect(idorSkill).toHaveAttribute(
      "title",
      "IDOR · Included when this specialist started",
    );
    expect(skills).toHaveTextContent("Source aware discovery");
    expect(skills).toHaveTextContent("Included when this specialist started.");
    expect(screen.queryByText("vulnerabilities/idor")).not.toBeInTheDocument();
  });

  it("records a privacy-safe transcript failure when realtime disconnects", () => {
    mockUseSubagentRealtime.mockReturnValue({
      message: null,
      state: "error",
      retry: jest.fn(),
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_transcript_failed",
      expect.objectContaining({
        subagent_id: "sa_active",
        error_category: "realtime_disconnected",
        has_persisted_activity: true,
        activity_message_count: 1,
      }),
    );
  });

  it("keeps the Active and Done groups visible when there are no children", () => {
    mockUseQuery.mockReturnValue([]);

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Active · 0" })).toBeVisible();
    expect(screen.getByText("No active subagents")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Done · 0" })).toBeVisible();
    expect(
      screen.getByText("Completed subagents will appear here"),
    ).toBeVisible();
  });

  it("shows a generic waiting state before the subagent emits activity", () => {
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [activeChild];
      if (query === "getOwned") {
        return args === "skip" ? undefined : activeChild;
      }
      return [
        {
          message_id: "subagent-message-0",
          sequence: 0,
          role: "user",
          parts: [{ type: "text", text: "Internal worker prompt" }],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(screen.getByText("Connecting to activity…")).toBeVisible();
    expect(
      screen.getByText("Inspect profile rendering for script injection."),
    ).toBeVisible();
    expect(
      screen.queryByText("Internal worker prompt"),
    ).not.toBeInTheDocument();
  });

  it("shows a stable user-facing empty state for a canceled subagent", () => {
    jest.useFakeTimers();
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [canceledChild];
      if (query === "getOwned") {
        return args === "skip" ? undefined : canceledChild;
      }
      return [
        {
          message_id: "subagent-message-prompt",
          sequence: 0,
          role: "user",
          parts: [{ type: "text", text: "Internal worker prompt" }],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        {
          message_id: "subagent-message-empty",
          sequence: 1,
          role: "assistant",
          parts: [],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_canceled",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(screen.getByText("Canceled by the parent agent.")).toBeVisible();
    expect(screen.queryByText("parent_requested")).not.toBeInTheDocument();
    const taskLabel = screen.getByText("Task", { exact: true });
    const activityLabel = screen.getByText("Activity", { exact: true });
    expect(
      screen.getByText("Canceled before any activity was recorded."),
    ).toBeVisible();
    expect(
      screen.queryByText("No transcript activity was persisted."),
    ).not.toBeInTheDocument();
    expect(
      taskLabel.compareDocumentPosition(activityLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByText("Connecting to activity…"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Subagent", { exact: true }),
    ).not.toBeInTheDocument();
    expect(mockUseSubagentRealtime).toHaveBeenCalledWith({
      subagentId: "sa_canceled",
      enabled: false,
    });
    act(() => jest.advanceTimersByTime(1_500));
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_transcript_resolved",
      expect.objectContaining({
        subagent_id: "sa_canceled",
        source: "empty_terminal",
        has_activity: false,
        activity_message_count: 0,
      }),
    );
    jest.useRealTimers();
  });

  it("records a transcript load timeout without capturing content", () => {
    jest.useFakeTimers();
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [activeChild];
      if (query === "getOwned") {
        return args === "skip" ? undefined : activeChild;
      }
      return undefined;
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    act(() => jest.advanceTimersByTime(10_000));
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_transcript_failed",
      expect.objectContaining({
        subagent_id: "sa_active",
        error_category: "persisted_load_timeout",
        load_latency_ms: 10_000,
      }),
    );
    jest.useRealTimers();
  });

  it("uses the normal Agent activity UI for tool summaries and running reasoning", () => {
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "listForParentMessage") return [activeChild];
      if (query === "getOwned") {
        return args === "skip" ? undefined : activeChild;
      }
      return [
        {
          message_id: "subagent-message-activity",
          sequence: 1,
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "reasoning",
              state: "done",
              text: "Planning the checks",
            },
            {
              type: "tool-read_file",
              toolCallId: "read-1",
              state: "output-available",
              input: { path: "/workspace/app.ts" },
              output: "source",
            },
            {
              type: "tool-web_search",
              toolCallId: "search-1",
              state: "output-available",
              input: { query: "example" },
              output: { results: [] },
            },
            { type: "step-start" },
            {
              type: "reasoning",
              state: "streaming",
              text: "Reviewing the results",
            },
          ],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /read a file, searched the web\. show tool details/i,
      }),
    ).toBeVisible();
    expect(screen.getAllByTestId("part-reasoning")).toHaveLength(2);
    for (const reasoning of screen.getAllByTestId("part-reasoning")) {
      expect(reasoning).toHaveAttribute(
        "data-keep-latest-reasoning-open",
        "true",
      );
    }
  });

  it("resolves a later update back to the child creation group", () => {
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "getOwned") return doneChild;
      if (query === "listForParentMessage") {
        return args?.parentMessageId === "parent-message" ? [doneChild] : [];
      }
      return [];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "later-parent-message",
          toolCallId: "tool-update",
          selectedSubagentId: "sa_done",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Rejected candidate" }),
    ).toBeVisible();
    expect(mockUseQuery).toHaveBeenCalledWith("listForParentMessage", {
      parentMessageId: "parent-message",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Back to subagent list" }),
    );
    expect(screen.getByRole("heading", { name: "Done · 1" })).toBeVisible();
  });

  it("resolves a model-facing short handle to the persisted child", () => {
    const childWithLongId = {
      ...doneChild,
      subagent_id: "sa_09041c08070448b5a5cee3c7c5454b66",
    };
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "getOwned") return null;
      if (query === "listForParentMessage") {
        return args?.parentMessageId === "parent-message"
          ? [childWithLongId]
          : [];
      }
      return [];
    });

    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-wait",
          selectedSubagentId: "sa_09041c08",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Rejected candidate" }),
    ).toBeVisible();
  });

  it("does not record abandonment when the resolved parent id changes", () => {
    let selectedChild = {
      ...activeChild,
      parent_message_id: "parent-message-a",
    };
    mockUseQuery.mockImplementation((query, args) => {
      if (query === "getOwned") return selectedChild;
      if (query === "listForParentMessage") return [selectedChild];
      return [];
    });

    const { rerender, unmount } = render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message-a",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    selectedChild = {
      ...selectedChild,
      parent_message_id: "parent-message-b",
    };
    rerender(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message-a",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    expect(captureAuthenticatedEvent).not.toHaveBeenCalledWith(
      "subagent_abandoned",
      expect.anything(),
    );
    unmount();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "subagent_abandoned",
      expect.objectContaining({ subagent_id: "sa_active" }),
    );
  });

  it("shows the timestamp on hover, then copies and rates the subagent result", async () => {
    const writeText = jest.fn<any>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_done",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    const timestamp = container.querySelector("time");
    expect(timestamp).toHaveClass("opacity-0");
    expect(timestamp).toHaveAttribute(
      "dateTime",
      new Date(persistedAssistantCreatedAt).toISOString(),
    );
    expect(
      screen.queryByText(
        "The validation is complete. The finding is rejected with high confidence.",
      ),
    ).not.toBeInTheDocument();
    const response = screen.getByText("The candidate does not reproduce.");
    expect(response).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Good response" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Poor response" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Regenerate response" }),
    ).not.toBeInTheDocument();

    const responseSection = response.closest("section");
    expect(responseSection).not.toBeNull();
    fireEvent.mouseEnter(responseSection!);
    expect(timestamp).toHaveClass("opacity-70");
    fireEvent.mouseLeave(responseSection!);
    expect(timestamp).toHaveClass("opacity-0");

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "The candidate does not reproduce.",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Good response" }));
    await waitFor(() =>
      expect(mockSetMessageFeedback).toHaveBeenCalledWith({
        messageId: "subagent-message-1",
        feedbackType: "positive",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Poor response" }));
    expect(
      await screen.findByPlaceholderText("What went wrong?"),
    ).toBeVisible();
    await waitFor(() =>
      expect(mockSetMessageFeedback).toHaveBeenCalledWith({
        messageId: "subagent-message-1",
        feedbackType: "negative",
      }),
    );

    fireEvent.change(screen.getByPlaceholderText("What went wrong?"), {
      target: { value: "The validator missed the supplied evidence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mockSetMessageFeedback).toHaveBeenCalledWith({
        messageId: "subagent-message-1",
        feedbackType: "negative",
        feedbackDetails: "The validator missed the supplied evidence.",
      }),
    );
  });

  it("allows a failed cancellation request to be retried", async () => {
    let resolveFetch!: (value: { ok: boolean }) => void;
    const fetchMock = jest.fn<any>().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }) as Promise<Response>,
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    render(
      <SubagentsSidebar
        content={{
          kind: "subagents",
          parentMessageId: "parent-message",
          toolCallId: "tool-1",
          selectedSubagentId: "sa_active",
        }}
        closeSidebar={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Canceling…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/subagents/sa_active/cancel",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );

    resolveFetch({ ok: false });
    expect(
      await screen.findByText("Could not cancel this subagent. Try again."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
    );
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });
});
