import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Exercise the actual end-of-turn settlement guard without starting a worker.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let guard = "";
function visit(node: ts.Node) {
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(source).includes("state.streamFinishReason") &&
    node.expression.getText(source).includes("activeGoal")
  )
    guard = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!guard) throw new Error("End-of-turn goal evaluation guard not found");
const body = ts.transpileModule(
  `let goalJudgePromise; let goalJudgment; return async () => { ${guard} return goalJudgment; };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
function setup({
  goal = true,
  reason = "stop",
  stopped = false,
  latestRun = "r1",
  latestState = "running",
} = {}) {
  const judge = jest.fn(async (_goal, _messages, _runId, cost) => {
    cost(0.01);
    return { verdict: "needs_input", reason: "Which file?", evidence: [] };
  });
  const usageTracker = { providerCost: 0, nonModelCost: 0 };
  const controller = new AbortController();
  if (stopped) controller.abort();
  const deps = {
    activeGoal: goal ? {} : undefined,
    userStopSignal: controller,
    state: { streamFinishReason: reason },
    getGoal: jest.fn(async () => ({
      activeRunId: latestRun,
      state: latestState,
    })),
    ctx: { run: { id: "r1" } },
    chatId: "chat",
    userId: "user",
    judgeGoalCompletion: judge,
    goalFinalMessages: [
      {
        id: "r1",
        role: "assistant",
        parts: [{ type: "text", text: "Which file?" }],
      },
    ],
    messagesForAccounting: [
      {
        id: "user-reply",
        role: "user",
        parts: [{ type: "text", text: "ORCHID" }],
      },
    ],
    goalFinalMessageId: "r1",
    goalRunMessageIds: new Set(["r1"]),
    usageTracker,
    chatLogger: undefined,
  };
  return {
    settle: new Function(...Object.keys(deps), body)(...Object.values(deps)),
    judge,
    usageTracker,
    messages: deps.goalFinalMessages,
  };
}
it.each(["stop", "tool-calls"])(
  "evaluates final %s once across settlement retries and bills once",
  async (reason) => {
    const run = setup({ reason });
    expect((await run.settle()).verdict).toBe("needs_input");
    await run.settle();
    expect(run.judge).toHaveBeenCalledTimes(1);
    expect(run.judge.mock.calls[0][1]).toBe(run.messages);
    expect((run.judge.mock.calls[0] as unknown[])[6]).toEqual([
      expect.objectContaining({ id: "user-reply", role: "user" }),
    ]);
    expect(run.usageTracker).toEqual({
      providerCost: 0.01,
      nonModelCost: 0.01,
    });
  },
);
it.each([
  { goal: false },
  { stopped: true },
  { reason: "error" },
  { reason: "length" },
  { reason: "elapsed-timeout" },
  { reason: "budget-exhausted" },
  { reason: "agent-run-spend-cap" },
  { reason: "" },
  { latestRun: "replacement" },
  { latestState: "paused" },
  { latestState: "needs_approval" },
])(
  "does not evaluate ordinary, interrupted, boundary or stale turns: %p",
  async (options) => {
    const run = setup(options);
    await run.settle();
    expect(run.judge).not.toHaveBeenCalled();
    expect(run.usageTracker.providerCost).toBe(0);
  },
);
