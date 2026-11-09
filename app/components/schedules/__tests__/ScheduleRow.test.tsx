import { fireEvent, render, screen } from "@testing-library/react";
import { ScheduleRow } from "../ScheduleRow";
import type { AgentSchedule } from "@/lib/schedules/types";

it("keeps running once distinct from resuming a paused schedule", () => {
  const schedule: AgentSchedule = {
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
  const onAction = jest.fn();
  const props = {
    schedule,
    enabled: true,
    computerUnavailable: false,
    pending: false,
    onAction,
    onEdit: jest.fn(),
    onDelete: jest.fn(),
  };
  const view = render(
    <ul>
      <ScheduleRow {...props} />
    </ul>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Run Lab check now" }));
  fireEvent.click(screen.getByRole("button", { name: "Resume schedule" }));
  expect(onAction.mock.calls).toEqual([["run"], ["resume"]]);

  view.rerender(
    <ul>
      <ScheduleRow {...props} enabled={false} />
    </ul>,
  );
  expect(
    screen.getByRole("button", { name: "Run Lab check now" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Resume schedule" }),
  ).not.toBeInTheDocument();
});
