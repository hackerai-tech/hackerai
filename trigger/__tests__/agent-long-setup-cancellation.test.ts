import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Execute the actual catch block without booting the Trigger worker or its
// remote services. This keeps cleanup/return ordering covered by behavior.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let outerCatch: ts.Block | undefined;
function visit(node: ts.Node) {
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
    expect(d.classifyAgentLongError).toHaveBeenCalledWith(error);
    expect(d.metadata.set).not.toHaveBeenCalledWith("status", "canceled");
  },
);
