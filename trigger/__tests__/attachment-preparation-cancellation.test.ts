import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function executeCatch(
  file: string,
  marker: string,
  dependencies: Record<string, unknown>,
  error: unknown,
) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let block: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isCatchClause(node) &&
      node.block.getText(source).includes(marker) &&
      node.block.getText(source).includes('writer.write({ type: "abort" })')
    )
      block = node.block;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!block) throw new Error("Preparation cleanup catch not found");
  const code = ts.transpileModule(
    `return (async () => { let preparationCanceled = false; ${block.getText(source)} })();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return new Function("error", ...Object.keys(dependencies), code)(
    error,
    ...Object.values(dependencies),
  );
}

it.each(["trigger/agent-long.ts", "lib/api/chat-handler.ts"])(
  "%s settles setup cancellation without an error chunk",
  async (file) => {
    const userStopSignal = new AbortController();
    userStopSignal.abort();
    const writer = { write: jest.fn() };
    const release = jest.fn(async () => {});
    const refund = jest.fn(async () => {});
    const deps = {
      userStopSignal,
      writer,
      hasObservedUsage: () => false,
      paidDailyFreeAllowanceUsageTracker: { hasUsage: false },
      releasePaidDailyFreeAllowanceReservation: release,
      releaseFreeRunLockOnce: release,
      usageRefundTracker: { refund },
      preemptiveTimeout: { clear: jest.fn() },
      subscriberStopped: false,
      cancellationSubscriber: { stop: jest.fn(async () => {}) },
      ptySessionManager: { closeAll: jest.fn(async () => {}) },
      chatId: "test-chat",
      endpoint: "/api/chat",
      phLogger: { warn: jest.fn() },
      shutdownPostHog: jest.fn(),
      posthog: {},
    };
    await expect(
      executeCatch(
        file,
        "releasePaidDailyFreeAllowanceReservation",
        deps,
        userStopSignal.signal.reason,
      ),
    ).resolves.toBeUndefined();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenCalledWith({ type: "abort" });
    writer.write.mockClear();
    const unrelated = new Error("Cleanup could not be confirmed");
    await expect(
      executeCatch(
        file,
        "releasePaidDailyFreeAllowanceReservation",
        deps,
        unrelated,
      ),
    ).rejects.toBe(unrelated);
    expect(writer.write).not.toHaveBeenCalled();
  },
);
