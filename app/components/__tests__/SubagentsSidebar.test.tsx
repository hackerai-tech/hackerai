import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockUseQuery = jest.fn<any>();
const mockSetMessageFeedback = jest.fn<any>();
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
  useSubagentRealtime: () => ({
    message: null,
    state: "connecting",
    retry: jest.fn(),
  }),
}));

const captureAuthenticatedEvent = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) =>
    captureAuthenticatedEvent(...args),
}));

jest.mock("../MessagePartHandler", () => ({
  MessagePartHandler: ({ part }: { part: { text?: string } }) => (
    <div>{part.text}</div>
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

const persistedAssistantCreatedAt = Date.now() - 60_000;

describe("SubagentsSidebar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMessageFeedback.mockResolvedValue("updated");
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

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible();
    expect(closeSidebar).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSidebar).toHaveBeenCalledTimes(1);
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
