import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentGoalEditor } from "../AgentGoalEditor";
import { setMockQueryResult } from "@/__mocks__/convex-react";
import { toast } from "sonner";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));
const goal = {
  _id: "goal",
  chatId: "chat",
  generation: 1,
  startedAt: 100,
  state: "running",
  activeRunId: "run",
  objective: "Original goal",
  criteria: ["Original goal"],
};

describe("simple goal sidebar editor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setMockQueryResult(goal);
    global.fetch = jest
      .fn()
      .mockImplementation(async (_url, init) =>
        init?.method === "POST"
          ? { ok: true, json: async () => ({ state: "paused" }) }
          : { ok: true, json: async () => ({ goal }) },
      );
  });
  it("opens, edits and closes without pausing or making a control request", async () => {
    const stop = jest.fn();
    const close = jest.fn();
    render(
      <AgentGoalEditor
        chatId="chat"
        onClose={close}
        stopRunBeforeControl={stop}
      />,
    );
    const input = await screen.findByRole("textbox", {
      name: "Goal objective",
    });
    expect(input).toHaveValue("Original goal");
    expect(
      screen.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    fireEvent.change(input, { target: { value: "Changed goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Close goal editor" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("only stops on Save and uses the generation read after stop-and-save", async () => {
    let current = { ...goal, generation: 2 };
    jest.mocked(fetch).mockImplementation(
      async (_url, init) =>
        ({
          ok: true,
          json: async () =>
            init?.method === "POST" ? { state: "paused" } : { goal: current },
        }) as Response,
    );
    const stop = jest.fn(async () => {
      current = { ...current, generation: 3 };
      return true;
    });
    const close = jest.fn();
    const { rerender } = render(
      <AgentGoalEditor
        chatId="chat"
        onClose={close}
        stopRunBeforeControl={stop}
      />,
    );
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Goal objective" }),
      { target: { value: "Changed goal" } },
    );
    setMockQueryResult(current);
    rerender(
      <AgentGoalEditor
        chatId="chat"
        onClose={close}
        stopRunBeforeControl={stop}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Changed goal");
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(stop).toHaveBeenCalledWith("run");
    expect(fetch).toHaveBeenCalledWith(
      "/api/agent-goal",
      expect.objectContaining({
        body: JSON.stringify({
          objective: "Changed goal",
          criteria: ["Changed goal"],
          action: "update",
          chatId: "chat",
          generation: 3,
        }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Goal updated. Resume when ready.",
    );
  });
  it("keeps the draft and does not update when saving the active response fails", async () => {
    const stop = jest.fn().mockResolvedValue(false);
    const close = jest.fn();
    render(
      <AgentGoalEditor
        chatId="chat"
        onClose={close}
        stopRunBeforeControl={stop}
      />,
    );
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Keep my edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop and save",
    );
    expect(screen.getByRole("textbox")).toHaveValue("Keep my edit");
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/agent-goal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(close).not.toHaveBeenCalled();
  });
  it.each([null, { ...goal, objective: "Changed elsewhere" }])(
    "keeps edits and blocks Save after the saved goal changes or is cleared",
    async (current) => {
      const view = () => <AgentGoalEditor chatId="chat" onClose={jest.fn()} />;
      const { rerender } = render(view());
      fireEvent.change(await screen.findByRole("textbox"), {
        target: { value: "My draft" },
      });
      setMockQueryResult(current);
      rerender(view());
      expect(screen.getByRole("textbox")).toHaveValue("My draft");
      expect(
        screen.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent(
        "changed or was cleared",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("checks fresh state before stopping and rejects a change not yet delivered to the browser", async () => {
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ goal: { ...goal, objective: "New objective" } }),
    } as Response);
    const stop = jest.fn();
    render(
      <AgentGoalEditor
        chatId="chat"
        onClose={jest.fn()}
        stopRunBeforeControl={stop}
      />,
    );
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "My draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed or was cleared",
    );
    expect(stop).not.toHaveBeenCalled();
  });
  it("preserves a draft when the goal finishes while editing and can save it for explicit resume", async () => {
    const close = jest.fn();
    const view = () => <AgentGoalEditor chatId="chat" onClose={close} />;
    const { rerender } = render(view());
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Next objective" },
    });
    const completed = { ...goal, state: "achieved", activeRunId: undefined };
    setMockQueryResult(completed);
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ goal: completed }),
    } as Response);
    rerender(view());
    expect(screen.getByRole("textbox")).toHaveValue("Next objective");
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
  it("does not stop work if the editor closes during the initial state read", async () => {
    let resolve!: (value: Response) => void;
    jest.mocked(fetch).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stop = jest.fn();
    const { unmount } = render(
      <AgentGoalEditor
        chatId="chat"
        onClose={jest.fn()}
        stopRunBeforeControl={stop}
      />,
    );
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "My draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    unmount();
    await act(async () =>
      resolve({ ok: true, json: async () => ({ goal }) } as Response),
    );
    expect(stop).not.toHaveBeenCalled();
  });
});
