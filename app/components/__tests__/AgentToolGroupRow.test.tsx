import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentToolGroupRow } from "../AgentToolGroupRow";
import type { ChatMessage } from "@/types";

jest.mock("../AgentActivityRow", () => ({
  AgentActivityRow: ({ part }: { part: { type: string } }) => (
    <div data-testid="grouped-tool-detail">{part.type}</div>
  ),
}));

const message = {
  id: "assistant-1",
  role: "assistant",
  parts: [],
} as unknown as ChatMessage;

const activities = [
  {
    id: "tool:read-1",
    part: {
      type: "tool-read_file",
      toolCallId: "read-1",
      state: "output-available",
    } as ChatMessage["parts"][number],
    partIndex: 0,
  },
  {
    id: "tool:shell-1",
    part: {
      type: "tool-shell",
      toolCallId: "shell-1",
      state: "output-available",
    } as ChatMessage["parts"][number],
    partIndex: 1,
  },
];

const group = (animateOnMount: boolean) => (
  <AgentToolGroupRow
    activities={activities}
    animateOnMount={animateOnMount}
    isLastMessage
    message={message}
    status="streaming"
    summary="Read a file and ran a command"
    terminalChunksByToolCallId={new Map()}
  />
);

const renderGroup = (animateOnMount: boolean) => render(group(animateOnMount));

describe("AgentToolGroupRow", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("smoothly closes a newly completed live group after a short delay", () => {
    jest.useFakeTimers();
    renderGroup(true);

    const trigger = screen.getByRole("button", {
      name: /read a file and ran a command\. hide tool details/i,
    });
    const content = document.querySelector('[data-slot="collapsible-content"]');

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(content).toHaveClass("worked-for-content");
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", {
        name: /read a file and ran a command\. show tool details/i,
      }),
    ).toBeInTheDocument();
  });

  it("starts historical groups closed and keeps their details accessible", () => {
    renderGroup(false);

    const trigger = screen.getByRole("button", {
      name: /read a file and ran a command\. show tool details/i,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);
  });

  it("closes if streaming ends before the auto-collapse timeout", () => {
    jest.useFakeTimers();
    const { rerender } = renderGroup(true);

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");

    rerender(group(false));
    act(() => {
      jest.advanceTimersByTime(0);
    });

    expect(
      screen.getByRole("button", { name: /show tool details/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves a user's choice when streaming ends", () => {
    const { rerender } = renderGroup(true);
    const trigger = screen.getByRole("button", { name: /hide tool details/i });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /show tool details/i }));
    rerender(group(false));

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
