import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentToolGroupRow } from "../AgentToolGroupRow";
import type { ChatMessage } from "@/types";

const mockCaptureScrollPosition = jest.fn();
const mockPreserveScrollPosition = jest.fn(
  (change: () => void, _isOpening: boolean) => change(),
);

jest.mock("@/components/ai-elements/worked-for", () => ({
  useScrollPreservation: () => ({
    captureScrollPosition: mockCaptureScrollPosition,
    preserveScrollPosition: mockPreserveScrollPosition,
  }),
}));

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
    groupId="group-1"
    isLastMessage
    message={message}
    onMount={jest.fn()}
    status="streaming"
    summary={summary}
    terminalChunksByToolCallId={new Map()}
  />
);

const renderGroup = (animateOnMount: boolean) => render(group(animateOnMount));

describe("AgentToolGroupRow", () => {
  beforeEach(() => {
    mockCaptureScrollPosition.mockClear();
    mockPreserveScrollPosition.mockClear();
  });

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

    expect(mockCaptureScrollPosition).toHaveBeenCalledWith(trigger);
    expect(mockPreserveScrollPosition).toHaveBeenCalledWith(
      expect.any(Function),
      false,
    );
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

  it("finishes its mount animation if streaming ends before the timeout", () => {
    jest.useFakeTimers();
    const { rerender } = renderGroup(true);

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");

    rerender(group(false));
    act(() => {
      jest.advanceTimersByTime(499);
    });

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");

    act(() => {
      jest.advanceTimersByTime(1);
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

  it("keeps a failed group summary neutral while preserving accessible details", () => {
    render(
      group(false, [
        activities[0],
        {
          ...activities[1],
          part: {
            ...activities[1].part,
            state: "output-available",
            output: { result: { exitCode: 124, timedOut: true } },
          } as ChatMessage["parts"][number],
        },
      ]),
    );

    const row = screen.getByTestId("agent-tool-group-row");
    const trigger = screen.getByRole("button", {
      name: /some tools failed\. show tool details/i,
    });
    expect(row).toHaveAttribute("data-outcome", "error");
    expect(
      document.querySelector('[data-summary-icon="mixed"]'),
    ).not.toHaveClass("text-destructive");

    fireEvent.click(trigger);
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);
  });

  it("uses the full row while keeping the chevron touch-visible and hover-only on desktop", () => {
    renderGroup(false);

    const trigger = screen.getByRole("button", { name: /show tool details/i });
    const chevron = screen.getByTestId("agent-tool-group-chevron");
    expect(trigger).toHaveClass("w-full");
    expect(trigger).not.toHaveClass("desktop:w-fit");
    expect(chevron).toHaveClass("opacity-0");
    expect(chevron).toHaveClass("group-hover:opacity-100");
    expect(chevron).toHaveClass("group-focus-visible:opacity-100");
    expect(chevron).toHaveClass("touch-device:!opacity-100");
  });
});
