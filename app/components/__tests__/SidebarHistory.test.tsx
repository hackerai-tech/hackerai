import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import type SidebarHistoryType from "../SidebarHistory";

jest.mock("../ChatItem", () => ({
  __esModule: true,
  default: ({ id, title, isStreaming, isAwaitingApproval }: any) => (
    <div data-testid={`chat-item-${id}`}>
      <span>{title}</span>
      {isAwaitingApproval ? (
        <span data-testid={`awaiting-approval-${id}`}>Awaiting approval</span>
      ) : null}
      {isStreaming ? (
        <span data-testid={`streaming-${id}`}>loading</span>
      ) : null}
    </div>
  ),
}));

const SidebarHistory = require("../SidebarHistory")
  .default as typeof SidebarHistoryType;

const chat = (overrides: Record<string, unknown>) => ({
  _id: overrides.id,
  id: overrides.id,
  title: "Chat",
  ...overrides,
});

describe("SidebarHistory", () => {
  it("marks chats with active ask streams as streaming", () => {
    render(
      <SidebarHistory
        chats={[chat({ id: "ask-chat", active_stream_id: "stream-1" })]}
        paginationStatus="Exhausted"
      />,
    );

    expect(screen.getByTestId("streaming-ask-chat")).toBeInTheDocument();
  });

  it("marks chats with active agent trigger runs as streaming", () => {
    render(
      <SidebarHistory
        chats={[chat({ id: "agent-chat", active_trigger_run_id: "run-1" })]}
        paginationStatus="Exhausted"
      />,
    );

    expect(screen.getByTestId("streaming-agent-chat")).toBeInTheDocument();
  });

  it("does not mark idle chats as streaming", () => {
    render(
      <SidebarHistory
        chats={[chat({ id: "idle-chat" })]}
        paginationStatus="Exhausted"
      />,
    );

    expect(screen.queryByTestId("streaming-idle-chat")).not.toBeInTheDocument();
  });

  it("marks chats with pending agent approval", () => {
    render(
      <SidebarHistory
        chats={[
          chat({
            id: "approval-chat",
            active_trigger_run_id: "run-1",
            active_agent_approval_pending: true,
          }),
        ]}
        paginationStatus="Exhausted"
      />,
    );

    expect(
      screen.getByTestId("awaiting-approval-approval-chat"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("streaming-approval-chat")).toBeInTheDocument();
  });
});
