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

it("keeps an automatically derived criterion aligned with an edited objective", () => {
  setMockQueryResult({ ...goal, criteria: [goal.objective] });
  render(<AgentGoalEditor chatId="chat" onClose={jest.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
    target: { value: "Updated objective" },
  });
  expect(
    screen.getByRole("textbox", { name: "Goal success criteria" }),
  ).toHaveValue("Updated objective");
});

it("explains invalid criteria before saving and permits correction without losing the objective", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  const close = jest.fn();
  render(<AgentGoalEditor chatId="chat" onClose={close} />);
  const criteria = screen.getByRole("textbox", {
    name: "Goal success criteria",
  });
  const save = screen.getByRole("button", { name: "Save and pause" });
  fireEvent.change(criteria, {
    target: {
      value: Array.from({ length: 9 }, (_, i) => `Outcome ${i + 1}`).join("\n"),
    },
  });
  expect(criteria).toHaveAccessibleDescription(
    expect.stringContaining("up to 8"),
  );
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(criteria, { target: { value: "x".repeat(1001) } });
  expect(criteria).toHaveAccessibleDescription(
    expect.stringContaining("1,000 characters"),
  );
  expect(save).toBeDisabled();
  fireEvent.change(criteria, {
    target: { value: "The requested result is verified." },
  });
  expect(save).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Goal objective" })).toHaveValue(
    "Old objective",
  );
  fireEvent.click(save);
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it("can save a long edited objective without an oversized automatic criterion", async () => {
  setMockQueryResult({ ...goal, criteria: [goal.objective] });
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  const close = jest.fn();
  render(<AgentGoalEditor chatId="chat" onClose={close} />);
  const objective = "A".repeat(4000);
  fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
    target: { value: objective },
  });
  const save = screen.getByRole("button", { name: "Save and pause" });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(close).toHaveBeenCalled());
  const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
  expect(body.objective).toBe(objective);
  expect(body.criteria[0].length).toBeLessThanOrEqual(1000);
});
