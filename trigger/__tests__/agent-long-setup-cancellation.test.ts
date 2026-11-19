import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { PostHog } from "posthog-node";
import { createAgentStopSignal } from "@/lib/chat/agent-stop-signal";
import { createAgentRunReporting } from "@/lib/analytics/agent-run-reporting";
import {
  getLocalStopDiagnostic,
  LOCAL_CONNECTION_LOST_FINISH_REASON,
  LocalConnectionLostError,
} from "@/lib/chat/local-connection-stop";

// Execute the actual catch block without booting the Trigger worker or its
// remote services. This keeps cleanup/return ordering covered by behavior.
const source = ts.createSourceFile(
  "agent-long.ts",
  fs.readFileSync(path.resolve(__dirname, "../agent-long.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let outerCatch: ts.Block | undefined;
let preparationCatch: ts.Block | undefined;
let localStopCallback: ts.Expression | undefined;
let stopSetup: ts.Statement[] | undefined;
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "sandboxManager.stopOnLocalDisconnect"
  )
    localStopCallback = node.arguments[0];
  if (
    ts.isCatchClause(node) &&
    node.block.getText(source).includes("canceledDuringPreparation")
  )
    preparationCatch = node.block;
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

if (!localStopCallback) throw new Error("Local stop callback not found");
const localStopCallbackBody = ts.transpileModule(
  `return (${localStopCallback.getText(source)});`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/** Actual stop setup plus the actual manager callback, with real reporting. */
function startRun({
  recordLocalStop,
  warnFault,
  triggerSignal = new AbortController().signal,
}: {
  recordLocalStop?: (reason: unknown) => void;
  warnFault?: boolean;
  triggerSignal?: AbortSignal;
} = {}) {
  const capture = jest.fn();
  const warn = jest.fn(() => {
    if (warnFault) throw new Error("log sink unavailable");
  });
  const runReporting = createAgentRunReporting({
    posthog: { capture } as unknown as PostHog,
    runId: "run-test",
    userId: "user-test",
    chatId: "chat-test",
    subscription: "pro",
    endpoint: "/api/agent",
  });
  if (recordLocalStop) runReporting.recordLocalStop = recordLocalStop;
  const setup = new Function(
    "createAgentStopSignal",
    "triggerSignal",
    "triggerLogger",
    "ctx",
    "chatId",
    "runReporting",
    stopSetupBody,
  )(
    createAgentStopSignal,
    triggerSignal,
    { warn },
    { run: { id: "run-test" } },
    "chat-test",
    runReporting,
  );
  const onLocalConnectionLost: (error: unknown) => void = new Function(
    "stopSignal",
    "getLocalStopDiagnostic",
    "LocalConnectionLostError",
    localStopCallbackBody,
  )(setup.stopSignal, getLocalStopDiagnostic, LocalConnectionLostError);
  const terminal = () => {
    runReporting.finalize({ canceled: triggerSignal.aborted });
    return capture.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === "hackerai-agent_run")?.properties;
  };
  return { ...setup, warn, runReporting, onLocalConnectionLost, terminal };
}

describe("first local stop through the actual Trigger callback", () => {
  it("aborts with the manager's own error and reports its first cause", () => {
    const run = startRun();
    const first = new LocalConnectionLostError("selected_host_left");
    run.onLocalConnectionLost(first);
    run.onLocalConnectionLost(new LocalConnectionLostError("setup_timeout"));
    expect(run.userStopSignal.signal.reason).toBe(first);
    expect(run.stopSignal.source).toBe("local_connection_lost");
    expect(run.terminal()).toMatchObject({
      outcome: "aborted",
      finish_reason: LOCAL_CONNECTION_LOST_FINISH_REASON,
      local_stop_reason: "selected_host_left",
    });
    run.stopSignal.dispose();
  });

  it.each([
    [
      "budget",
      (run: ReturnType<typeof startRun>) =>
        run.stopSignal.abort("active_runtime_budget", new Error("budget")),
    ],
    ["platform", () => undefined],
  ] as const)(
    "keeps an earlier %s stop authoritative over a later local callback",
    (kind, stopFirst) => {
      const platform = new AbortController();
      const run = startRun({ triggerSignal: platform.signal });
      if (kind === "platform") platform.abort(new Error("PRIVATE platform"));
      else stopFirst(run);
      const earlier = run.userStopSignal.signal.reason;
      run.onLocalConnectionLost(
        new LocalConnectionLostError("selected_host_left"),
      );
      expect(run.userStopSignal.signal.reason).toBe(earlier);
      expect(run.warn).toHaveBeenCalledTimes(1);
      const terminal = run.terminal();
      expect(terminal?.finish_reason).toBe("unknown");
      expect(JSON.stringify(terminal)).not.toMatch(/local_stop_|PRIVATE/);
      platform.signal.removeEventListener("abort", run.forwardTriggerAbort);
      run.stopSignal.dispose();
    },
  );

  it("replaces a forged callback argument with a generic local stop", () => {
    const run = startRun();
    run.onLocalConnectionLost({
      reason: "selected_host_left",
      secret: "PRIVATE",
    });
    const reason = run.userStopSignal.signal.reason;
    expect(reason).toBeInstanceOf(LocalConnectionLostError);
    expect(getLocalStopDiagnostic(reason)).toEqual({ reason: "unavailable" });
    expect(JSON.stringify(run.terminal())).not.toContain("PRIVATE");
    run.stopSignal.dispose();
  });

  it("still cancels when a hostile callback argument's traps throw", () => {
    const run = startRun();
    const trap = jest.fn(() => {
      throw new Error("PRIVATE trap");
    });
    const hostile = new Proxy(
      new LocalConnectionLostError("selected_host_left"),
      { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
    );
    expect(() => run.onLocalConnectionLost(hostile)).not.toThrow();
    const reason = run.userStopSignal.signal.reason;
    expect(reason).not.toBe(hostile);
    expect(getLocalStopDiagnostic(reason)).toEqual({ reason: "unavailable" });
    expect(trap).not.toHaveBeenCalled();
    expect(run.terminal()).toMatchObject({
      outcome: "aborted",
      finish_reason: LOCAL_CONNECTION_LOST_FINISH_REASON,
      local_stop_reason: "unavailable",
    });
    run.stopSignal.dispose();
  });

  it("records the first cause even when the existing stop log faults", () => {
    const run = startRun({ warnFault: true });
    const later = jest.fn();
    run.userStopSignal.signal.addEventListener("abort", later);
    const first = new LocalConnectionLostError("subscription_unsubscribed");
    expect(() => run.onLocalConnectionLost(first)).not.toThrow();
    expect(run.userStopSignal.signal.reason).toBe(first);
    expect(run.warn).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(run.terminal()).toMatchObject({
      local_stop_reason: "subscription_unsubscribed",
    });
    run.stopSignal.dispose();
  });

  it("still cancels and logs when cause reporting faults", () => {
    const run = startRun({
      recordLocalStop: () => {
        throw new Error("reporting fault");
      },
    });
    const later = jest.fn();
    run.userStopSignal.signal.addEventListener("abort", later);
    const first = new LocalConnectionLostError("presence_error");
    expect(() => run.onLocalConnectionLost(first)).not.toThrow();
    expect(run.userStopSignal.signal.reason).toBe(first);
    expect(run.warn).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    run.stopSignal.dispose();
  });
});

if (!preparationCatch) throw new Error("Agent preparation catch not found");
const preparationCatchBody = ts.transpileModule(
  `return (async () => ${preparationCatch.getText(source)})();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

it.each([
  ["the stop itself", true],
  ["a follow-on abort error", false],
  ["a failed chat update", false],
] as const)(
  "reports a pre-stream local stop as canceled with its cause after %s",
  async (scenario, sameError) => {
    const run = startRun();
    const stop = new LocalConnectionLostError("setup_timeout");
    run.runReporting.setStage("preparation");
    run.onLocalConnectionLost(stop);
    const thrown = sameError ? stop : new DOMException("aborted", "AbortError");
    const dependencies = {
      userStopSignal: run.userStopSignal,
      runReporting: run.runReporting,
      agentLongDurationExceeded: false,
      isHandledUserRateLimitError: () => false,
      hasObservedUsage: () => false,
      releasePaidDailyFreeAllowanceReservation: jest.fn(async () => {}),
      releaseFreeRunLockOnce: jest.fn(async () => {}),
      localConnectionLost: () =>
        run.userStopSignal.signal.reason instanceof LocalConnectionLostError,
      preparationCanceled: false,
      updateChat: jest.fn(async () => {
        if (scenario === "a failed chat update")
          throw new Error("metadata unavailable");
      }),
      chatId: "chat-test",
      ctx: { run: { id: "run-test" } },
      LOCAL_CONNECTION_LOST_FINISH_REASON,
      recordAgentLongChatMetadataUpdateFailure: jest.fn(),
      userId: "user-test",
      usageRefundTracker: { refund: jest.fn(async () => {}) },
      writer: { write: jest.fn() },
    };
    await expect(
      new Function("error", ...Object.keys(dependencies), preparationCatchBody)(
        thrown,
        ...Object.values(dependencies),
      ),
    ).resolves.toBeUndefined();
    expect(dependencies.updateChat).toHaveBeenCalledWith({
      chatId: "chat-test",
      expectedActiveTriggerRunId: "run-test",
      finishReason: LOCAL_CONNECTION_LOST_FINISH_REASON,
    });
    expect(dependencies.usageRefundTracker.refund).toHaveBeenCalledTimes(1);
    expect(dependencies.writer.write).toHaveBeenCalledWith({ type: "abort" });
    expect(run.terminal()).toMatchObject({
      outcome: "aborted",
      failure_stage: "preparation",
      failure_kind: "canceled",
      finish_reason: LOCAL_CONNECTION_LOST_FINISH_REASON,
      abort_source: "unknown",
      local_stop_diagnostic_version: 1,
      local_stop_reason: "setup_timeout",
    });
    run.stopSignal.dispose();
  },
);

it("keeps a preparation error authoritative when a local stop arrives during its cleanup", async () => {
  const run = startRun();
  run.runReporting.setStage("preparation");
  const dependencies = {
    userStopSignal: run.userStopSignal,
    runReporting: run.runReporting,
    agentLongDurationExceeded: false,
    isHandledUserRateLimitError: () => false,
    hasObservedUsage: () => false,
    releasePaidDailyFreeAllowanceReservation: jest.fn(async () => {
      run.onLocalConnectionLost(
        new LocalConnectionLostError("selected_host_left"),
      );
    }),
    releaseFreeRunLockOnce: jest.fn(async () => {}),
    localConnectionLost: () =>
      run.userStopSignal.signal.reason instanceof LocalConnectionLostError,
    preparationCanceled: false,
    updateChat: jest.fn(async () => {}),
    chatId: "chat-test",
    ctx: { run: { id: "run-test" } },
    LOCAL_CONNECTION_LOST_FINISH_REASON,
    recordAgentLongChatMetadataUpdateFailure: jest.fn(),
    userId: "user-test",
    usageRefundTracker: { refund: jest.fn(async () => {}) },
    writer: { write: jest.fn() },
  };
  await new Function(
    "error",
    ...Object.keys(dependencies),
    preparationCatchBody,
  )(
    new TypeError("PRIVATE preparation failure"),
    ...Object.values(dependencies),
  );
  // Existing product handling still stops for the lost host and refunds.
  expect(dependencies.updateChat).toHaveBeenCalledWith(
    expect.objectContaining({
      finishReason: LOCAL_CONNECTION_LOST_FINISH_REASON,
    }),
  );
  expect(dependencies.usageRefundTracker.refund).toHaveBeenCalledTimes(1);
  expect(dependencies.writer.write).toHaveBeenCalledWith({ type: "abort" });
  // Reporting keeps the original failure, not the later first abort.
  const terminal = run.terminal();
  expect(terminal).toMatchObject({
    outcome: "error",
    failure_kind: "error",
    failure_category: "type_error",
    finish_reason: "unknown",
  });
  expect(JSON.stringify(terminal)).not.toMatch(/local_stop_|PRIVATE/);
  run.stopSignal.dispose();
});
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
    goalFailed: false,
    goalUsageExhausted: false,
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
