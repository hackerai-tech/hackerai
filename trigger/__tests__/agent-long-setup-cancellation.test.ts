import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createAgentStopSignal } from "@/lib/chat/agent-stop-signal";

// Execute the actual catch block without booting the Trigger worker or its
// remote services. This keeps cleanup/return ordering covered by behavior.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let outerCatch: ts.Block | undefined;
let stopSetup: ts.Statement[] | undefined;
function visit(node: ts.Node) {
  if (ts.isBlock(node)) {
    const start = node.statements.findIndex(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            declaration.name.getText(source) === "terminalAgentState",
        ),
    );
    const end = node.statements.findIndex(
      (statement) =>
        ts.isIfStatement(statement) &&
        statement.expression.getText(source) === "triggerSignal.aborted",
    );
    if (start >= 0 && end > start)
      stopSetup = [...node.statements.slice(start, end + 1)];
  }
  if (
    ts.isCatchClause(node) &&
    node.block
      .getText(source)
      .includes('releaseFreeRunLockBestEffort("outer_catch")')
  ) {
    outerCatch = node.block;
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!stopSetup) throw new Error("Agent stop setup not found");
const stopSetupBody = ts.transpileModule(
  `${stopSetup.map((statement) => statement.getText(source)).join("\n")}
   return { userStopSignal, stopSignal, forwardTriggerAbort };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

it.each([false, true])(
  "attributes the actual Trigger forwarding path, including startup cancellation (already=%s)",
  (alreadyAborted) => {
    const trigger = new AbortController();
    const privateReason = { message: "synthetic private platform detail" };
    const warn = jest.fn();
    if (alreadyAborted) trigger.abort(privateReason);
    const setup = new Function(
      "createAgentStopSignal",
      "triggerSignal",
      "triggerLogger",
      "ctx",
      "chatId",
      stopSetupBody,
    )(
      createAgentStopSignal,
      trigger.signal,
      { warn },
      { run: { id: "run-test" } },
      "chat-test",
    );
    if (!alreadyAborted) trigger.abort(privateReason);
    expect(setup.userStopSignal.signal.reason).toBe(privateReason);
    expect(warn.mock.calls).toEqual([
      [
        "[agent-long] stop signal aborted",
        {
          event: "agent_long_stop_signal_aborted",
          run_id: "run-test",
          chat_id: "chat-test",
          stop_source: "trigger_platform",
        },
      ],
    ]);
    setup.stopSignal.abort("active_runtime_budget");
    expect(warn).toHaveBeenCalledTimes(1);
    trigger.signal.removeEventListener("abort", setup.forwardTriggerAbort);
    setup.stopSignal.dispose();
  },
);
if (!outerCatch) throw new Error("Agent run catch block not found");
const catchBody = ts.transpileModule(
  `return (async () => ${outerCatch.getText(source)})();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(
  triggerSignal: AbortSignal,
  streamPiped = false,
  used = false,
) {
  const ordinaryFailure = new Error("ordinary failure handler reached");
  const dependencies = {
    triggerSignal,
    runReporting: { fail: jest.fn() },
    isHandledUserRateLimitError: () => false,
    streamPiped,
    hasObservedUsage: () => used,
    releasePaidDailyFreeAllowanceReservation: jest.fn(async () => {}),
    releaseFreeRunLockBestEffort: jest.fn(async () => {}),
    usageRefundTracker: { refund: jest.fn(async () => {}) },
    metadata: { set: jest.fn() },
    phLogger: { flush: jest.fn(async () => {}) },
    memoryTelemetry: { checkpoint: jest.fn() },
    classifyAgentLongError: jest.fn(() => {
      throw ordinaryFailure;
    }),
    ChatSDKError: class extends Error {},
    chatId: "test-chat",
    assistantMessageId: "test-run",
  };
  const execute = (error: unknown) =>
    new Function("error", ...Object.keys(dependencies), catchBody)(
      error,
      ...Object.values(dependencies),
    );
  return { dependencies, execute, ordinaryFailure };
}

it.each([false, true])(
  "handles setup cancellation after cleanup without failure reporting (usage=%s)",
  async (used) => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const { dependencies: d, execute } = fixture(
      controller.signal,
      false,
      used,
    );
    await expect(execute(controller.signal.reason)).resolves.toEqual({
      chatId: "test-chat",
      assistantMessageId: "test-run",
    });
    expect(d.runReporting.fail).toHaveBeenCalledWith(
      controller.signal.reason,
      "canceled",
    );
    expect(d.releaseFreeRunLockBestEffort).toHaveBeenCalledWith("outer_catch");
    expect(d.releasePaidDailyFreeAllowanceReservation).toHaveBeenCalledTimes(
      used ? 0 : 1,
    );
    expect(d.usageRefundTracker.refund).toHaveBeenCalledTimes(used ? 0 : 1);
    expect(d.metadata.set).toHaveBeenCalledWith("status", "canceled");
    expect(d.memoryTelemetry.checkpoint).not.toHaveBeenCalled();
    expect(d.classifyAgentLongError).not.toHaveBeenCalled();
    expect(d.phLogger.flush).toHaveBeenCalled();
  },
);

it.each(["not_canceled", "unrelated_error", "streaming"])(
  "preserves ordinary failure handling for %s",
  async (scenario) => {
    const controller = new AbortController();
    const abortError = new DOMException("Stopped", "AbortError");
    if (scenario !== "not_canceled") controller.abort(abortError);
    const error =
      scenario === "unrelated_error"
        ? new Error("Database unavailable")
        : abortError;
    const {
      dependencies: d,
      execute,
      ordinaryFailure,
    } = fixture(controller.signal, scenario === "streaming");
    await expect(execute(error)).rejects.toBe(ordinaryFailure);
    expect(d.runReporting.fail).toHaveBeenCalledWith(
      error,
      scenario === "streaming" ? "canceled" : "error",
    );
    expect(d.classifyAgentLongError).toHaveBeenCalledWith(error);
    expect(d.metadata.set).not.toHaveBeenCalledWith("status", "canceled");
  },
);
