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
      localConnectionLost: () => false,
      userStopSignal,
      triggerSignal: new AbortController().signal,
      agentLongDurationExceeded: false,
      runReporting: { fail: jest.fn() },
      isHandledUserRateLimitError: () => false,
      writer,
      hasObservedUsage: () => false,
      paidDailyFreeAllowanceUsageTracker: { hasUsage: false },
      reportIncompleteAskUsageCost: jest.fn(async () => {}),
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
    if (file === "trigger/agent-long.ts") {
      expect(deps.runReporting.fail).toHaveBeenCalledWith(
        userStopSignal.signal.reason,
        "canceled",
      );
    }
    expect(refund).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    expect(writer.write).toHaveBeenCalledWith({ type: "abort" });
    if (file === "lib/api/chat-handler.ts") {
      expect(deps.reportIncompleteAskUsageCost).toHaveBeenCalledWith("setup");
    }
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
    if (file === "trigger/agent-long.ts") {
      expect(deps.runReporting.fail).toHaveBeenLastCalledWith(
        unrelated,
        "error",
      );
      deps.agentLongDurationExceeded = true;
      await executeCatch(
        file,
        "releasePaidDailyFreeAllowanceReservation",
        deps,
        userStopSignal.signal.reason,
      );
      expect(deps.runReporting.fail).toHaveBeenLastCalledWith(
        userStopSignal.signal.reason,
        "elapsed_timeout",
      );
    }
  },
);

it("refunds and aborts after local loss even when finish metadata cannot be saved", async () => {
  const userStopSignal = new AbortController();
  const error = new Error("connection lost");
  userStopSignal.abort(error);
  const failure = new Error("database unavailable");
  const updateChat = jest.fn(async () => {
    throw failure;
  });
  const refund = jest.fn(async () => {});
  const writer = { write: jest.fn() };
  const recordAgentLongChatMetadataUpdateFailure = jest.fn();
  await expect(
    executeCatch(
      "trigger/agent-long.ts",
      "releasePaidDailyFreeAllowanceReservation",
      {
        userStopSignal,
        localConnectionLost: () => true,
        agentLongDurationExceeded: false,
        runReporting: { fail: jest.fn() },
        isHandledUserRateLimitError: () => false,
        hasObservedUsage: () => false,
        releasePaidDailyFreeAllowanceReservation: jest.fn(async () => {}),
        releaseFreeRunLockOnce: jest.fn(async () => {}),
        usageRefundTracker: { refund },
        updateChat,
        recordAgentLongChatMetadataUpdateFailure,
        chatId: "test-chat",
        userId: "test-user",
        ctx: { run: { id: "test-run" } },
        LOCAL_CONNECTION_LOST_FINISH_REASON: "local-connection-lost",
        writer,
      },
      error,
    ),
  ).resolves.toBeUndefined();
  expect(updateChat).toHaveBeenCalledWith({
    chatId: "test-chat",
    expectedActiveTriggerRunId: "test-run",
    finishReason: "local-connection-lost",
  });
  expect(recordAgentLongChatMetadataUpdateFailure).toHaveBeenCalledWith(
    failure,
    { chatId: "test-chat", userId: "test-user", runId: "test-run" },
  );
  expect(refund).toHaveBeenCalledTimes(1);
  expect(writer.write).toHaveBeenCalledWith({ type: "abort" });
});
