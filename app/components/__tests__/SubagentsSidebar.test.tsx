import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockUseQuery = jest.fn<any>();
jest.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subagents: {
      listForParentMessage: "listForParentMessage",
      getMessagesOwned: "getMessagesOwned",
    },
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
  parent_trigger_run_id: "parent-run",
  parent_tool_call_id: "tool-1",
  trigger_run_id: "child-run",
  status: "running",
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
  candidate: {
    title: "Rejected candidate",
    affected_asset: "https://example.test/search",
  },
  completed_at: Date.now() - 1_000,
};

describe("SubagentsSidebar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseQuery.mockImplementation((query) => {
      if (query === "listForParentMessage") return [activeChild, doneChild];
      return [
        {
          sequence: 0,
          role: "user",
          parts: [{ type: "text", text: "Validate this candidate" }],
          created_at: Date.now(),
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

    expect(screen.getByRole("heading", { name: "Active" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Done" })).toBeVisible();
    expect(screen.getByText("Active candidate")).toBeVisible();
    expect(screen.getByText("Rejected candidate")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open Active candidate, Running/i,
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Active candidate" }),
    ).toBeVisible();
    expect(screen.getByText("Validate this candidate")).toBeVisible();
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
      await screen.findByText("Could not cancel this validation. Try again."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
    );
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });
});
