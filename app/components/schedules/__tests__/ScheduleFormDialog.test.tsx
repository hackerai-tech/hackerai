import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScheduleFormDialog } from "../ScheduleFormDialog";
import type { ScheduleDefinition } from "@/lib/schedules/recurrence";
const initial: ScheduleDefinition = {
  name: "QA schedule",
  prompt: "Reply hello",
  model: "default",
  timing: { type: "once", at: Date.now() + 86400000 },
};
function local(at: number) {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
it("saves the edited native date, not the original displayed value", async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn();
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={initial}
      editing
      onSave={save}
      onClose={close}
    />,
  );
  const selected = local(Date.now() + 172800000);
  fireEvent.input(screen.getByLabelText("Date and time"), {
    target: { value: selected },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      ...initial,
      timing: { type: "once", at: new Date(selected).getTime() },
    }),
  );
  expect(close).toHaveBeenCalled();
});
it("keeps instructions and shows a retryable error when saving fails", async () => {
  const save = jest.fn().mockRejectedValue(Error("Connection failed"));
  const close = jest.fn();
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={initial}
      editing
      onSave={save}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection failed",
  );
  expect(screen.getByLabelText("Instructions")).toHaveValue("Reply hello");
  expect(close).not.toHaveBeenCalled();
});
it("asks before discarding edited instructions", () => {
  const close = jest.fn();
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={initial}
      editing
      onSave={jest.fn()}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Edited instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Discard your unsaved changes?")).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Instructions")).toHaveValue(
    "Edited instructions",
  );
});
it("shows the saved interval time while renaming and a new time only after timing changes", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-11-07T23:00:00Z"));
  try {
    const at = Date.now() + 60000;
    render(
      <ScheduleFormDialog
        computers={[]}
        initial={{ ...initial, timing: { minutes: 15, type: "interval" } }}
        editing
        saved={{ enabled: true, consumed: false, nextRunAt: at }}
        onSave={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    const label = (timestamp: number) =>
      new Date(timestamp).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      });
    expect(screen.getByText(label(at))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Repeat every (minutes)"), {
      target: { value: "30" },
    });
    expect(screen.getByText(label(Date.now() + 1800000))).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});
it("describes a paused schedule without promising another run", () => {
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={{ ...initial, timing: { type: "interval", minutes: 15 } }}
      editing
      saved={{ enabled: false, consumed: false, nextRunAt: null }}
      onSave={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByText(/This schedule will stay paused/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Next run:/)).not.toBeInTheDocument();
});
it("keeps an edited interval when its selected recurrence button is pressed again", async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={{ ...initial, timing: { type: "interval", minutes: 15 } }}
      editing
      onSave={save}
      onClose={jest.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Repeat every (minutes)"), {
    target: { value: "30" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Interval", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      ...initial,
      timing: { type: "interval", minutes: 30 },
    }),
  );
});

it.each([false, true])(
  "saves a past one-time schedule without rearming it (consumed=%s)",
  async (consumed) => {
    const save = jest.fn().mockResolvedValue(undefined);
    const past = {
      ...initial,
      timing: { type: "once" as const, at: Date.now() - 86400000 },
    };
    render(
      <ScheduleFormDialog
        computers={[]}
        initial={past}
        editing
        saved={{ enabled: false, consumed, nextRunAt: null }}
        onSave={save}
        onClose={jest.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed schedule" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ ...past, name: "Renamed schedule" }),
    );
  },
);

it("allows editing an unavailable saved computer without changing its execution target", async () => {
  const execution = {
    type: "local" as const,
    preference: "environment:12345678-1234-4123-8123-123456789abc",
    name: "Lab computer",
    workingDirectory: "/tmp/original",
  };
  const save = jest.fn().mockResolvedValue(undefined);
  render(
    <ScheduleFormDialog
      computers={[]}
      initial={{ ...initial, execution }}
      editing
      onSave={save}
      onClose={jest.fn()}
    />,
  );
  expect(screen.getByLabelText("Starting folder")).toHaveValue("/tmp/original");
  expect(screen.getByText(/You can still save changes/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed", execution }),
    ),
  );
});
it("keeps folders scoped to their computer when switching targets", () => {
  const first = {
    preference: "environment:12345678-1234-4123-8123-123456789abc",
    name: "First computer",
  };
  const second = {
    preference: "environment:12345678-1234-4123-8123-123456789abd",
    name: "Second computer",
  };
  render(
    <ScheduleFormDialog
      computers={[first, second]}
      initial={{
        ...initial,
        execution: {
          type: "local",
          ...first,
          workingDirectory: "/first-project",
        },
      }}
      editing
      onSave={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Run on" }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name: "Second computer" }));
  expect(screen.getByLabelText("Starting folder")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Starting folder"), {
    target: { value: "/second-project" },
  });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Run on" }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name: "First computer" }));
  expect(screen.getByLabelText("Starting folder")).toHaveValue(
    "/first-project",
  );
});
