import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentGoalEditor } from "../AgentGoalEditor";
import { setMockQueryResult } from "@/__mocks__/convex-react";
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));
const goal = {
  _id: "goal",
  chatId: "chat",
  generation: 4,
  objective: "Old objective",
  criteria: ["Old evidence"],
  state: "running",
  activeRunId: "run",
  runs: 1,
  maxRuns: 3,
};
beforeEach(() => {
  setMockQueryResult(goal);
});
it("saves edits during work without increasing its budget", async () => {
  const close = jest.fn();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  render(<AgentGoalEditor chatId="chat" onClose={close} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
    target: { value: "New objective" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Goal success criteria" }),
    { target: { value: "New evidence" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and pause" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
  expect(body).toMatchObject({
    action: "update",
    chatId: "chat",
    generation: 4,
    objective: "New objective",
    criteria: ["New evidence"],
  });
  expect(body).not.toHaveProperty("maxRuns");
});
it("keeps a failed edit visible and rejects a stale draft", async () => {
  const close = jest.fn();
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ message: "Try again" }),
  });
  const { rerender } = render(
    <AgentGoalEditor chatId="chat" onClose={close} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and pause" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
  expect(screen.getByRole("textbox", { name: "Goal objective" })).toHaveValue(
    "Keep this draft",
  );
  expect(close).not.toHaveBeenCalled();
  setMockQueryResult({ ...goal, generation: 5 });
  rerender(<AgentGoalEditor chatId="chat" onClose={close} />);
  expect(screen.getByRole("button", { name: "Save and pause" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Goal objective" })).toHaveValue(
    "Keep this draft",
  );
});
