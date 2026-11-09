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

it.each(["once", "interval"] as const)(
  "only keeps a consumed %s schedule ended while it is still one-time",
  async (type) => {
    const onAction = jest.fn();
    render(
      <ul>
        <ScheduleRow
          schedule={{
            id: "schedule",
            definition: {
              name: "Lab check",
              prompt: "Reply hello",
              model: "default",
              timing:
                type === "once"
                  ? { type, at: Date.now() - 60_000 }
                  : { type, minutes: 60 },
            },
            enabled: false,
            consumed: true,
            nextRunAt: null,
            runs: [],
          }}
          enabled
          computerUnavailable={false}
          pending={false}
          onAction={onAction}
          onEdit={jest.fn()}
          onDelete={jest.fn()}
        />
      </ul>,
    );
    expect(
      screen.getByText(type === "once" ? "Ended" : "Paused"),
    ).toBeVisible();
    if (type === "once") {
      expect(
        screen.queryByRole("button", { name: "Resume schedule" }),
      ).toBeNull();
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Resume schedule" }));
      expect(onAction).toHaveBeenCalledWith("resume");
      onAction.mockClear();
    }
    fireEvent.keyDown(
      screen.getByRole("button", { name: "More actions for Lab check" }),
      { key: "ArrowDown" },
    );
    const resume = await screen.findByRole("menuitem", {
      name: "Resume schedule",
    });
    if (type === "once") {
      expect(resume).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(resume);
      expect(onAction).not.toHaveBeenCalled();
    } else {
      expect(resume).not.toHaveAttribute("aria-disabled", "true");
      fireEvent.click(resume);
      expect(onAction).toHaveBeenCalledWith("resume");
    }
  },
);
