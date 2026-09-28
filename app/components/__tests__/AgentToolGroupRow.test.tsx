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

const liveActivities = activities.map((activity) => ({
  ...activity,
  part: {
    ...activity.part,
    state: "input-available",
  } as ChatMessage["parts"][number],
}));

const group = (
  settled: boolean,
  groupActivities = activities,
  summary = "Read a file, ran a command",
  restored = false,
) => (
  <AgentToolGroupRow
    activities={groupActivities}
    isLastMessage
    message={message}
    restored={restored}
    settled={settled}
    status="streaming"
    summary={summary}
    terminalChunksByToolCallId={new Map()}
  />
);

const renderGroup = (settled: boolean) => render(group(settled));

/** Mounts the run live and then settles it, as a streaming step does. */
const renderSettlingGroup = (restored = false) => {
  const result = render(group(false, liveActivities, undefined, restored));
  result.rerender(group(true, activities, undefined, restored));
  return result;
};

describe("AgentToolGroupRow", () => {
  beforeEach(() => {
    mockCaptureScrollPosition.mockClear();
    mockPreserveScrollPosition.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders a live run expanded in place without a summary header", () => {
    const { rerender } = render(group(false, [liveActivities[0]]));

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(1);
    expect(screen.getByTestId("agent-tool-group-row")).toHaveAttribute(
      "data-phase",
      "live",
    );

    rerender(group(false, liveActivities));

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);
    expect(
      document.querySelector('[data-slot="collapsible-content"]'),
    ).not.toHaveAttribute("data-animate-open");
  });

  it("keeps the streamed tool details mounted when the run settles", () => {
    const { rerender } = render(group(false, liveActivities));
    const detailsBeforeSettle = screen.getAllByTestId("grouped-tool-detail");

    rerender(group(true, activities));

    const detailsAfterSettle = screen.getAllByTestId("grouped-tool-detail");
    expect(detailsAfterSettle).toHaveLength(2);
    detailsAfterSettle.forEach((detail, index) => {
      expect(detail).toBe(detailsBeforeSettle[index]);
    });
  });

  it("slides the summary header in and folds a settled live run after a short delay", () => {
    jest.useFakeTimers();
    renderSettlingGroup();

    const trigger = screen.getByRole("button", {
      name: /read a file, ran a command\. hide tool details/i,
    });
    const content = document.querySelector('[data-slot="collapsible-content"]');

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("data-entering", "true");
    expect(trigger).toHaveClass("agent-tool-group-header");
    expect(content).toHaveClass("agent-tool-group-content");
    expect(content).not.toHaveAttribute("data-animate-open");
    expect(screen.getByTestId("agent-tool-group-row")).toHaveAttribute(
      "data-phase",
      "settled",
    );
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    act(() => {
      jest.advanceTimersByTime(1);
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

  it("folds a restored run immediately once it settles", () => {
    jest.useFakeTimers();
    renderSettlingGroup(true);

    expect(
      screen.getByRole("button", { name: /show tool details/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("does not fold a settled single-tool run", () => {
    jest.useFakeTimers();
    const { rerender } = render(group(false, [liveActivities[0]]));

    rerender(group(true, [activities[0]]));
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(1);
  });

  it("starts historical groups closed and keeps their details accessible", () => {
    renderGroup(true);

    const trigger = screen.getByRole("button", {
      name: /read a file, ran a command\. show tool details/i,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("data-entering");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("grouped-tool-detail")).toHaveLength(2);
    expect(
      document.querySelector('[data-slot="collapsible-content"]'),
    ).toHaveAttribute("data-animate-open", "true");
  });

  it("finishes folding if streaming ends before the timeout", () => {
    jest.useFakeTimers();
    const { rerender } = renderSettlingGroup();

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");

    rerender(
      <AgentToolGroupRow
        activities={activities}
        isLastMessage
        message={message}
        settled
        status="ready"
        summary="Read a file, ran a command"
        terminalChunksByToolCallId={new Map()}
      />,
    );
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

  it("preserves a user's choice instead of auto-folding", () => {
    jest.useFakeTimers();
    renderSettlingGroup();
    const trigger = screen.getByRole("button", { name: /hide tool details/i });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /show tool details/i }));
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(
      screen.getByRole("button", { name: /hide tool details/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("uses the category icon for homogeneous work and the tool icon for a mix", () => {
    const { rerender } = renderGroup(true);

    expect(document.querySelector('[data-summary-icon="mixed"]')).toBeTruthy();

    rerender(
      group(
        true,
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
      group(true, [
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
    renderGroup(true);

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
