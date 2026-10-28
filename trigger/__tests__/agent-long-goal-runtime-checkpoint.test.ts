import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createActiveRuntimeBudget } from "@/lib/chat/active-runtime-budget";
import {
  createAgentRuntimeCheckpoint,
  resolveAgentRuntimeCheckpointEnabled,
} from "@/lib/chat/agent-runtime-checkpoint";

// Execute the worker's actual claim and runtime setup, with remote I/O faked.
// This catches wiring regressions without loading the Trigger SDK/services.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const statements = new Map<string, string>();
let claim: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (["activeGoal", "runtimeBudget", "runtimeCheckpoint"].includes(name))
        statements.set(name, node.getText(source));
    }
  }
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(source) ===
      "payload.goalGeneration !== undefined" &&
    node.thenStatement.getText(source).includes("goalApi.agentGoals.claimRun")
  )
    claim = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!claim || statements.size !== 3)
  throw new Error("Worker goal/runtime setup not found");
const body = ts.transpileModule(
  `return (async () => {
    ${statements.get("activeGoal")}
    ${claim}
    ${statements.get("runtimeBudget")}
    ${statements.get("runtimeCheckpoint")}
    return { runtimeBudget, runtimeCheckpoint };
  })();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

async function setup({
  goal = false,
  isAutoContinue = false,
  isAutomaticContinuation = false,
  claimed = true,
  enabled = true,
} = {}) {
  const exposed = jest.fn();
  const abort = jest.fn();
  const decision = jest.fn(async () => enabled);
  const mutation = jest.fn(async () =>
    claimed ? { generation: 2, state: "running" } : null,
  );
  const deps = {
    payload: goal ? { goalGeneration: 2 } : {},
    isAutoContinue,
    isAutomaticContinuation,
    goalConvex: () => ({ mutation }),
    goalApi: { agentGoals: { claimRun: "claimRun" } },
    goalServiceKey: () => "test-service-key",
    approvalSessionId: undefined,
    goalClaimed: false,
    captureGoalLifecycle: jest.fn(async () => {}),
    assertGoalExecutionAllowed: jest.fn(async () => {}),
    createActiveRuntimeBudget,
    createAgentRuntimeCheckpoint,
    resolveAgentRuntimeCheckpointEnabled,
    getPostHogBooleanFlagDecisionForUser: decision,
    AGENT_RUNTIME_CHECKPOINT_FLAG: "agent-runtime-checkpoint-v1",
    agentLongMaxDurationMs: 1000,
    taskStartTime: Date.now(),
    markAgentLongDurationExceeded: jest.fn(),
    runtimeSettlementWatchdog: undefined,
    stopSignal: { abort },
    userStopSignal: new AbortController(),
    triggerLogger: { warn: jest.fn() },
    ctx: { run: { id: "run-test" } },
    chatId: "chat-test",
    userId: "user-test",
    assistantMessageId: "message-test",
    AGENT_LONG_CLEANUP_GRACE_MS: 100,
    terminalAgentState: undefined,
    phLogger: { event: exposed },
  };
  const result = await new Function(...Object.keys(deps), body)(
    ...Object.values(deps),
  );
  return { ...result, exposed, abort, decision, mutation };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it.each([
  ["initial", false, false],
  ["resumed", false, false],
  ["automatic continuation", true, true],
] as const)(
  "excludes a claimed %s goal without changing its hard runtime stop",
  async (_, isAutoContinue, isAutomaticContinuation) => {
    const run = await setup({
      goal: true,
      isAutoContinue,
      isAutomaticContinuation,
    });
    try {
      expect(run.mutation).toHaveBeenCalledWith(
        "claimRun",
        expect.objectContaining({ generation: 2, runId: "run-test" }),
      );
      jest.advanceTimersByTime(900);
      expect(run.runtimeCheckpoint?.takeNotice()).toBeUndefined();
      run.runtimeCheckpoint?.recordExposure();
      expect(run.decision).not.toHaveBeenCalled();
      expect(run.exposed).not.toHaveBeenCalled();
      expect(run.abort).not.toHaveBeenCalled();
      jest.advanceTimersByTime(100);
      expect(run.abort).toHaveBeenCalledWith("active_runtime_budget");
      expect(run.runtimeCheckpoint?.takeNotice()).toBeUndefined();
    } finally {
      run.runtimeBudget.dispose();
    }
  },
);

it.each([false, true])(
  "preserves ordinary Agent warning eligibility (continuation=%s)",
  async (continuation) => {
    const run = await setup({
      isAutoContinue: continuation,
      isAutomaticContinuation: continuation,
    });
    try {
      expect(run.mutation).not.toHaveBeenCalled();
      expect(run.decision).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(899);
      expect(run.runtimeCheckpoint.takeNotice()).toBeUndefined();
      jest.advanceTimersByTime(1);
      expect(run.runtimeCheckpoint.takeNotice()).toContain(
        "<agent_runtime_checkpoint>",
      );
      run.runtimeCheckpoint.recordExposure();
      expect(run.exposed).toHaveBeenCalledTimes(1);
      expect(run.runtimeCheckpoint.takeNotice()).toBeUndefined();
      jest.advanceTimersByTime(100);
      expect(run.abort).toHaveBeenCalledWith("active_runtime_budget");
    } finally {
      run.runtimeBudget.dispose();
    }
  },
);

it("keeps a disabled ordinary assignment silent", async () => {
  const run = await setup({ enabled: false });
  try {
    jest.advanceTimersByTime(900);
    expect(run.runtimeCheckpoint.takeNotice()).toBeUndefined();
    run.runtimeCheckpoint.recordExposure();
    expect(run.exposed).not.toHaveBeenCalled();
  } finally {
    run.runtimeBudget.dispose();
  }
});

it("does not start runtime or checkpoint setup when the goal claim is rejected", async () => {
  const run = await setup({ goal: true, claimed: false });
  expect(run.runtimeBudget).toBeUndefined();
  expect(run.runtimeCheckpoint).toBeUndefined();
  expect(run.decision).not.toHaveBeenCalled();
  expect(run.exposed).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
