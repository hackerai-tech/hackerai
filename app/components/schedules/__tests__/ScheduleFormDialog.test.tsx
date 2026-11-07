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
