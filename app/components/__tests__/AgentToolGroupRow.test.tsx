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

const group = (
  animateOnMount: boolean,
  groupActivities = activities,
  summary = "Read a file, ran a command",
) => (
  <AgentToolGroupRow
    activities={groupActivities}
    animateOnMount={animateOnMount}
    isLastMessage
    message={message}
    status="streaming"
    summary={summary}
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
      name: /read a file, ran a command\. hide tool details/i,
    });
    const content = document.querySelector('[data-slot="collapsible-content"]');

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(content).toHaveClass("agent-tool-group-content");
    expect(content).toHaveClass("worked-for-content");
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", {
        name: /read a file, ran a command\. show tool details/i,
      }),
    ).toBeInTheDocument();
  });

  it("starts historical groups closed and keeps their details accessible", () => {
    renderGroup(false);

    const trigger = screen.getByRole("button", {
      name: /read a file, ran a command\. show tool details/i,
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

  it("uses the category icon for homogeneous work and the tool icon for a mix", () => {
    const { rerender } = renderGroup(false);

    expect(document.querySelector('[data-summary-icon="mixed"]')).toBeTruthy();

    rerender(
      group(
        false,
        [
          {
            id: "tool:write-1",
            part: {
              type: "tool-file",
              input: { action: "write", path: "/tmp/one.ts" },
              state: "output-available",
            } as ChatMessage["parts"][number],
            partIndex: 0,
          },
          {
            id: "tool:edit-1",
            part: {
              type: "tool-file",
              input: { action: "edit", path: "/tmp/two.ts" },
              state: "output-available",
            } as ChatMessage["parts"][number],
            partIndex: 1,
          },
        ],
        "Edited files",
      ),
    );

    expect(screen.getByRole("button", { name: /edited files/i })).toBeVisible();
    expect(document.querySelector('[data-summary-icon="edit"]')).toBeTruthy();
  });

  it("keeps the chevron visible on touch devices and hover-only on desktop", () => {
    renderGroup(false);

    const trigger = screen.getByRole("button", { name: /show tool details/i });
    const chevron = screen.getByTestId("agent-tool-group-chevron");
    expect(trigger).toHaveClass("w-full");
    expect(trigger).toHaveClass("desktop:w-fit");
    expect(chevron).toHaveClass("opacity-0");
    expect(chevron).toHaveClass("group-hover:opacity-100");
    expect(chevron).toHaveClass("group-focus-visible:opacity-100");
    expect(chevron).toHaveClass("touch-device:!opacity-100");
  });
});
