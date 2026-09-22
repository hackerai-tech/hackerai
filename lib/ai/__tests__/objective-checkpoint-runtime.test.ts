import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { ObjectiveCheckpointRuntime } from "../objective-checkpoint-runtime";
import {
  newObjectiveCheckpoint,
  objectiveCheckpointSchema,
  type ObjectiveCheckpoint,
} from "@/lib/chat/objective-checkpoint";

const options = (id: string) => ({ toolCallId: id, messages: [] });
async function invoke(tools: ToolSet, name: string, input: unknown, id = name) {
  return tools[name].execute!(input, options(id));
}
function setup(saved?: ObjectiveCheckpoint) {
  const abort = new AbortController();
  const snapshots: ObjectiveCheckpoint[] = [];
  const save = jest.fn(async (state: ObjectiveCheckpoint) => {
    snapshots.push(JSON.parse(JSON.stringify(state)));
  });
  const environment = jest.fn(async () => "connection:owned-desktop");
  const state = saved ?? newObjectiveCheckpoint("run-1");
  const event = jest.fn();
  const runtime = new ObjectiveCheckpointRuntime(
    state,
    save,
    environment,
    abort.signal,
    event,
  );
  const execute = jest.fn(async (_input: unknown) => ({
    result: { output: "No matching file", exitCode: 1 },
  }));
  const view = jest.fn(async () => ({ result: { exited: { exitCode: 0 } } }));
  const tools = runtime.wrap({
    run_terminal_cmd: tool({
      inputSchema: z.object({ command: z.string() }),
      execute,
    }),
    interact_terminal_session: tool({
      inputSchema: z.object({ session: z.string(), action: z.string() }),
      execute: view,
    }),
  });
  return {
    state,
    runtime,
    abort,
    save,
    snapshots,
    environment,
    tools,
    execute,
    view,
    event,
  };
}
async function assess(
  tools: ToolSet,
  action_id: string,
  outcome = "unsuccessful",
  observation = "Tool could not access the workspace",
) {
  return invoke(tools, "assess_objective_progress", {
    action_id,
    outcome,
    observation,
    blocker: "Workspace access is unavailable",
    artifact_refs: [],
    pending_action: "Read the requested source after access is restored",
  });
}

it("checkpoints two failed attempts with varied command arguments and returns partial work, spend and blocker", async () => {
  const t = setup();
  await invoke(t.tools, "run_terminal_cmd", { command: "ls /work" }, "a");
  await t.runtime.recordSpend(0.12);
  await assess(t.tools, "a");
  await invoke(
    t.tools,
    "run_terminal_cmd",
    { command: "find /work -type f" },
    "b",
  );
  await t.runtime.recordSpend(0.24);
  await assess(t.tools, "b");
  const restriction = t.runtime.restriction(t.tools)!;
  expect(restriction.instruction).toContain("Workspace access is unavailable");
  expect(restriction.instruction).toContain("No matching file");
  expect(restriction.instruction).toContain("0.24");
  expect(restriction.instruction).toContain("Read the requested source");
  await invoke(t.tools, "run_terminal_cmd", { command: "pwd" }, "c");
  expect(t.execute).toHaveBeenCalledTimes(2);
  expect(t.state.unsuccessfulAttempts).toBe(2);
  expect(t.snapshots.at(-1)?.blocker).toBeTruthy();
});

it("allows useful negative evidence and rejects repeated observations as progress", async () => {
  const t = setup();
  await invoke(
    t.tools,
    "run_terminal_cmd",
    { command: "rg missing /src" },
    "a",
  );
  await assess(
    t.tools,
    "a",
    "new_evidence",
    "The checked source does not contain the suspected call",
  );
  expect(t.state.unsuccessfulAttempts).toBe(0);
  expect(t.state.lastObservation).toContain("does not contain");
  await invoke(
    t.tools,
    "run_terminal_cmd",
    { command: "rg another /src" },
    "b",
  );
  await assess(
    t.tools,
    "b",
    "new_evidence",
    "THE CHECKED SOURCE DOES NOT CONTAIN THE SUSPECTED CALL",
  );
  expect(t.state.unsuccessfulAttempts).toBe(1);
});

it("serializes a parallel batch so it cannot bypass assessment", async () => {
  const t = setup();
  await Promise.all([
    invoke(t.tools, "run_terminal_cmd", { command: "first" }, "a"),
    invoke(t.tools, "run_terminal_cmd", { command: "second" }, "b"),
  ]);
  expect(t.execute).toHaveBeenCalledTimes(1);
  expect(t.runtime.restriction(t.tools)?.activeTools).toEqual([
    "assess_objective_progress",
  ]);
});

it("persists before effects and retains a completed result across a disconnect without replay", async () => {
  const t = setup();
  t.execute.mockImplementation(async () => {
    expect(t.snapshots.at(-1)?.actions[0].state).toBe("running");
    return {
      result: { output: "Saved marker at /tmp/owned-marker", exitCode: 0 },
    };
  });
  await invoke(t.tools, "run_terminal_cmd", { command: "write marker" }, "a");
  const restored = setup(objectiveCheckpointSchema.parse(t.snapshots.at(-1)));
  await restored.runtime.reconcile();
  await assess(restored.tools, "a", "completed", "Marker saved");
  const replay = await invoke(
    restored.tools,
    "run_terminal_cmd",
    { command: "write marker" },
    "new-call-id",
  );
  expect(restored.execute).not.toHaveBeenCalled();
  expect(replay).toMatchObject({
    executed: false,
    saved_result: expect.stringContaining("Saved marker"),
  });
});

it.each(["running", "outcome_unknown"] as const)(
  "does not replay a restored %s action",
  async (state) => {
    const saved = newObjectiveCheckpoint("run-1");
    saved.actions.push({
      id: "a",
      tool: "run_terminal_cmd",
      state,
      assessed: false,
    });
    const t = setup(saved);
    await t.runtime.reconcile();
    await invoke(t.tools, "run_terminal_cmd", { command: "write" }, "b");
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.state.actions[0].state).toBe("outcome_unknown");
    expect(t.runtime.restriction(t.tools)?.instruction).toContain(
      "unknown outcome",
    );
  },
);

it("reconciles an existing terminal session with a read-only view and no command replay", async () => {
  const saved = newObjectiveCheckpoint("run-1");
  saved.environment = "connection:owned-desktop";
  saved.actions.push({
    id: "a",
    tool: "run_terminal_cmd",
    state: "running",
    session: "owned-session",
    assessed: false,
  });
  const t = setup(saved);
  await t.runtime.reconcile();
  await invoke(t.tools, "reconcile_objective_action", { action_id: "a" });
  expect(t.view).toHaveBeenCalledWith(
    { session: "owned-session", action: "view" },
    expect.anything(),
  );
  expect(t.state.actions[0].state).toBe("completed");
  expect(t.execute).not.toHaveBeenCalled();
  expect(t.runtime.restriction(t.tools)?.activeTools).toEqual([
    "assess_objective_progress",
  ]);
});

it("bounds unresolved session reconciliation to two reads", async () => {
  const saved = newObjectiveCheckpoint("run-1");
  saved.actions.push({
    id: "a",
    tool: "run_terminal_cmd",
    state: "running",
    session: "owned-session",
    assessed: false,
  });
  const t = setup(saved);
  t.view.mockResolvedValue({ result: {} } as never);
  await t.runtime.reconcile();
  for (let i = 0; i < 3; i++)
    await invoke(t.tools, "reconcile_objective_action", { action_id: "a" });
  expect(t.view).toHaveBeenCalledTimes(2);
  expect(t.state.blocker).toBeTruthy();
});

it.each(["cancel", "budget"])(
  "honors %s abort during recovery before any tool runs",
  async (reason) => {
    const t = setup();
    t.environment.mockImplementation(async () => {
      t.abort.abort(new Error(reason));
      return "connection:owned-desktop";
    });
    await expect(t.runtime.reconcile()).rejects.toThrow(reason);
    await expect(
      invoke(t.tools, "run_terminal_cmd", { command: "write" }, "a"),
    ).rejects.toThrow(reason);
    expect(t.execute).not.toHaveBeenCalled();
  },
);

it.each(["changed", "unavailable", "artifacts"])(
  "checkpoints %s environment/artifact identity instead of assuming recovery",
  async (condition) => {
    const saved = newObjectiveCheckpoint("run-1");
    saved.environment =
      condition === "changed" ? "e2b:old" : "connection:owned-desktop";
    if (condition === "artifacts") saved.artifacts = ["/tmp/report.txt"];
    const t = setup(saved);
    if (condition === "unavailable")
      t.environment.mockRejectedValue(new Error("offline"));
    await t.runtime.reconcile();
    await invoke(t.tools, "run_terminal_cmd", { command: "write" }, "a");
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.state.blocker).toBeTruthy();
  },
);

it("fails closed when the write before execution fails", async () => {
  const t = setup();
  t.save.mockRejectedValue(new Error("offline"));
  await expect(
    invoke(t.tools, "run_terminal_cmd", { command: "write" }, "a"),
  ).rejects.toThrow("offline");
  expect(t.execute).not.toHaveBeenCalled();
  expect(t.runtime.restriction(t.tools)?.instruction).toContain(
    "storage failed",
  );
});

it("rejects fabricated action IDs and keeps telemetry free of observations and command arguments", async () => {
  const t = setup();
  await expect(assess(t.tools, "invented")).rejects.toThrow(
    "unassessed completed tool result",
  );
  await invoke(
    t.tools,
    "run_terminal_cmd",
    { command: "private command" },
    "a",
  );
  await assess(t.tools, "a", "new_evidence", "private observation");
  expect(JSON.stringify(t.event.mock.calls)).not.toMatch(
    /private command|private observation/,
  );
});
