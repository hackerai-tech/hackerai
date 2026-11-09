import { fireEvent, render, screen } from "@testing-library/react";
import { ScheduleRow } from "../ScheduleRow";
import type { AgentSchedule } from "@/lib/schedules/types";

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
  fireEvent.click(screen.getByRole("button", { name: "Resume Lab check" }));
  fireEvent.click(await openRunMenu());
  expect(props.onAction.mock.calls).toEqual([["resume"], ["run"]]);

  props.onAction.mockClear();
  view.rerender(<ScheduleRow {...props} enabled={false} />);
  expect(screen.getByRole("button", { name: "Edit Lab check" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Resume Lab check" })).toBeNull();
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
        screen.queryByRole("button", { name: "Resume Lab check" }),
      ).toBeNull();
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Resume Lab check" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Pause Lab check" }));
  expect(props.onAction).toHaveBeenCalledWith("pause");

  props.onAction.mockClear();
  view.rerender(<ScheduleRow {...props} pending />);
  for (const name of [
    "Edit Lab check",
    "Pause Lab check",
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
  fireEvent.click(screen.getByRole("button", { name: "Pause Lab check" }));
  expect(props.onAction.mock.calls).toEqual([["pause"]]);
  const run = await openRunMenu();
  expect(run).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(run);
  expect(props.onAction.mock.calls).toEqual([["pause"]]);
});
