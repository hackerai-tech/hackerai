import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { ScheduleRow } from "../ScheduleRow";
import type { AgentSchedule } from "@/lib/schedules/types";

const mockCapture = jest.fn();
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));
// A plain anchor: these tests follow links by href, not through the router.
jest.mock("next/link", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    __esModule: true,
    default: ({ onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) =>
      createElement("a", {
        ...rest,
        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
          onClick?.(event);
          event.preventDefault();
        },
      }),
  };
});
beforeEach(() => mockCapture.mockClear());

const paused: AgentSchedule = {
  id: "schedule",
  definition: {
    name: "Lab check",
    prompt: "Reply hello",
    model: "default",
    timing: { type: "interval", minutes: 60 },
  },
  enabled: false,
  consumed: false,
  nextRunAt: null,
  runs: [],
};

function rowProps(schedule = paused) {
  return {
    schedule,
    enabled: true,
    computerUnavailable: false,
    pending: false,
    onAction: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  };
}

async function openRunMenu() {
  fireEvent.keyDown(
    screen.getByRole("button", { name: "More actions for Lab check" }),
    { key: "ArrowDown" },
  );
  return screen.findByRole("menuitem", { name: "Run now" });
}

it("edits and resumes directly while keeping a one-off run separate", async () => {
  const props = rowProps();
  const view = render(<ScheduleRow {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Lab check" }));
  expect(props.onEdit).toHaveBeenCalledTimes(1);
  expect(props.onAction).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Resume schedule Lab check" }),
  );
  fireEvent.click(await openRunMenu());
  expect(props.onAction.mock.calls).toEqual([["resume"], ["run"]]);

  props.onAction.mockClear();
  view.rerender(<ScheduleRow {...props} enabled={false} />);
  expect(screen.getByRole("button", { name: "Edit Lab check" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Resume schedule Lab check" }),
  ).toBeNull();
  const run = await openRunMenu();
  expect(run).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(run);
  expect(props.onAction).not.toHaveBeenCalled();
});

it.each(["once", "interval"] as const)(
  "only keeps a consumed %s schedule ended while it is still one-time",
  async (type) => {
    const props = rowProps({
      ...paused,
      consumed: true,
      definition: {
        ...paused.definition,
        timing:
          type === "once"
            ? { type, at: Date.now() - 60_000 }
            : { type, minutes: 60 },
      },
    });
    render(<ScheduleRow {...props} />);
    expect(
      screen.getByText(type === "once" ? "Ended" : "Paused"),
    ).toBeVisible();
    if (type === "once") {
      expect(
        screen.queryByRole("button", { name: "Resume schedule Lab check" }),
      ).toBeNull();
    } else {
      fireEvent.click(
        screen.getByRole("button", { name: "Resume schedule Lab check" }),
      );
      expect(props.onAction).toHaveBeenCalledWith("resume");
      props.onAction.mockClear();
    }
    fireEvent.click(await openRunMenu());
    expect(props.onAction.mock.calls).toEqual([["run"]]);
  },
);

it("retains pause after eligibility loss and prevents actions while pending", () => {
  const props = rowProps({ ...paused, enabled: true });
  const view = render(<ScheduleRow {...props} enabled={false} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Pause schedule Lab check" }),
  );
  expect(props.onAction).toHaveBeenCalledWith("pause");

  props.onAction.mockClear();
  view.rerender(<ScheduleRow {...props} pending />);
  for (const name of [
    "Edit Lab check",
    "Pause schedule Lab check",
    "More actions for Lab check",
  ]) {
    const button = screen.getByRole("button", { name });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onEdit).not.toHaveBeenCalled();
});

it("blocks another run while a task is busy but still allows pausing future runs", async () => {
  const props = rowProps({
    ...paused,
    enabled: true,
    runs: [
      {
        id: "run",
        chatId: "chat",
        hasTask: true,
        status: "running",
        detail: null,
        createdAt: Date.now(),
      },
    ],
  });
  render(<ScheduleRow {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Pause schedule Lab check" }),
  );
  expect(props.onAction.mock.calls).toEqual([["pause"]]);
  const run = await openRunMenu();
  expect(run).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(run);
  expect(props.onAction.mock.calls).toEqual([["pause"]]);
});

describe("findings link", () => {
  it.each([
    [{}, null],
    [{ findingCount: 0 }, null],
    // A truncated flag without a positive count is not a finding.
    [{ findingCount: 0, findingCountTruncated: true }, null],
    [{ findingCount: 1 }, "1 finding"],
    [{ findingCount: 3 }, "3 findings"],
    [{ findingCount: 100, findingCountTruncated: true }, "100+ findings"],
  ] as const)("shows %j as %s", (counts, label) => {
    render(<ScheduleRow {...rowProps({ ...paused, ...counts })} />);
    const link = screen.queryByRole("link", { name: /finding/ });
    if (label === null) {
      expect(link).toBeNull();
      return;
    }
    expect(link).toHaveTextContent(label);
    expect(link).toHaveAccessibleName(`${label} from Lab check`);
  });

  it("opens Findings filtered to this schedule and reports no content", () => {
    const props = rowProps({
      ...paused,
      id: "k17/schedule id",
      findingCount: 2,
    });
    render(<ScheduleRow {...props} />);
    const link = screen.getByRole("link", {
      name: "2 findings from Lab check",
    });
    expect(link).toHaveAttribute(
      "href",
      "/findings?schedule=k17%2Fschedule%20id",
    );
    fireEvent.click(link);
    // No schedule name, id, count or target leaves the page.
    expect(mockCapture.mock.calls).toEqual([
      ["agent_schedule_findings_opened"],
    ]);
    expect(props.onAction).not.toHaveBeenCalled();
  });
});

it("keeps resuming an interrupted run in its task apart from resuming the schedule", () => {
  const props = rowProps({
    ...paused,
    runs: [
      {
        id: "run",
        chatId: "chat-9",
        hasTask: true,
        status: "interrupted",
        detail: null,
        createdAt: Date.now(),
      },
    ],
  });
  render(<ScheduleRow {...props} />);
  const task = screen.getByRole("link", { name: "Resume in task" });
  expect(task).toHaveAttribute("href", "/c/chat-9");
  fireEvent.click(task);
  // Following the run's link never changes the schedule.
  expect(props.onAction).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Resume schedule Lab check" }),
  );
  expect(props.onAction.mock.calls).toEqual([["resume"]]);
});

it.each(["finished", "failed"] as const)(
  "does not offer to resume a %s run",
  (status) => {
    render(
      <ScheduleRow
        {...rowProps({
          ...paused,
          enabled: true,
          runs: [
            {
              id: "run",
              chatId: "chat-9",
              hasTask: true,
              status,
              detail: null,
              createdAt: Date.now(),
            },
          ],
        })}
      />,
    );
    expect(screen.queryByRole("link", { name: "Resume in task" })).toBeNull();
    expect(
      screen.getByRole("link", {
        name: status === "finished" ? "Open result" : "Open task",
      }),
    ).toHaveAttribute("href", "/c/chat-9");
  },
);

it("explains an unavailable computer once and describes Run now with it", async () => {
  const local: AgentSchedule = {
    ...paused,
    enabled: true,
    nextRunAt: Date.now() + 3_600_000,
    definition: {
      ...paused.definition,
      execution: {
        type: "local",
        preference: "environment:12345678-1234-4123-8123-123456789abc",
        name: "Lab computer",
        workingDirectory: "/tmp/lab",
      },
    },
  };
  const view = render(<ScheduleRow {...rowProps(local)} computerUnavailable />);
  // The skip rule must survive shortening the row: no catch-up, no cloud.
  expect(screen.getAllByText(/never move to the cloud/)).toHaveLength(1);
  const run = await openRunMenu();
  expect(run).toHaveAccessibleDescription(
    /Unavailable, runs skipped.*aren’t made up later.*never move to the cloud/,
  );
  fireEvent.keyDown(run, { key: "Escape" });

  view.rerender(<ScheduleRow {...rowProps(local)} />);
  expect(screen.queryByText(/Unavailable/)).toBeNull();
  expect(await openRunMenu()).not.toHaveAccessibleDescription();
});
