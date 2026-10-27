import { afterEach, beforeEach, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createChatFinishObserver } from "../chat-finish-observer";

const context = {
  requestId: "iad1::abc12-1700000000000-abcdef123456",
  userId: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  chatId: "11111111-1111-4111-8111-111111111111",
  mode: "ask",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("identifies a held finishing wait without resolving or retrying it", async () => {
  const title = deferred<string>();
  const operation = jest.fn(() => title.promise);
  const result = createChatFinishObserver(context)(
    "wait_title_generation",
    operation,
  );
  await jest.advanceTimersByTimeAsync(9_999);
  expect(warn).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
    event: "chat_finish_wait_slow",
    route: "/api/chat",
    stage: "wait_title_generation",
    phase: "primary",
    outcome: "pending",
    request_id: context.requestId,
    user_id: context.userId,
    chat_id: context.chatId,
    stage_elapsed_ms: 10_000,
    timer_lateness_ms: 0,
  });
  expect(operation).toHaveBeenCalledTimes(1);
  title.resolve("title");
  await expect(result).resolves.toBe("title");
  await jest.advanceTimersByTimeAsync(120_000);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("shares two warning attempts across stages, messages, and retry callbacks", async () => {
  const observeFinish = createChatFinishObserver(context);
  for (const phase of [
    "primary",
    "provider_retry",
    "provider_retry",
  ] as const) {
    const save = deferred<object>();
    const result = observeFinish("save_message", () => save.promise, phase);
    await jest.advanceTimersByTimeAsync(65_000);
    const value = {};
    save.resolve(value);
    await expect(result).resolves.toBe(value);
  }
  expect(warn).toHaveBeenCalledTimes(2);
  expect(
    warn.mock.calls.map(([line]) => JSON.parse(line as string).warning_index),
  ).toEqual([1, 2]);
  expect(jest.getTimerCount()).toBe(0);
});

it("clears pending diagnostics on rejection and preserves the original error", async () => {
  const save = deferred<void>();
  const failure = new Error("save failed");
  const result = createChatFinishObserver(context)(
    "save_message",
    () => save.promise,
    "provider_retry",
  );
  const rejection = expect(result).rejects.toBe(failure);
  save.reject(failure);
  await rejection;
  await jest.advanceTimersByTimeAsync(120_000);
  expect(warn).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("preserves SDK usage thenables without requiring Promise cleanup methods", async () => {
  const value = { tokens: 3 };
  const promise = Promise.resolve(value);
  const usage = { then: promise.then.bind(promise) };
  const result = createChatFinishObserver(context)(
    "resolve_usage",
    () => usage,
  );
  await expect(result).resolves.toBe(value);
  expect(jest.getTimerCount()).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

it("does not let logging failures change the operation or reset its budget", async () => {
  warn.mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  const work = deferred<number>();
  const result = createChatFinishObserver(context)(
    "update_chat",
    () => work.promise,
  );
  await jest.advanceTimersByTimeAsync(200_000);
  expect(warn).toHaveBeenCalledTimes(2);
  work.resolve(42);
  await expect(result).resolves.toBe(42);
  expect(jest.getTimerCount()).toBe(0);
});

it("exports only closed stages and validated opaque context", async () => {
  const privateValue = "private-target-and-credential";
  const work = deferred<void>();
  const observeFinish = createChatFinishObserver({
    requestId: privateValue,
    userId: privateValue,
    chatId: privateValue,
    mode: privateValue,
    rawContent: privateValue,
  } as typeof context);
  const result = observeFinish(
    privateValue as "save_message",
    () => work.promise,
  );
  await jest.advanceTimersByTimeAsync(10_000);
  const line = warn.mock.calls[0][0] as string;
  expect(line).not.toContain(privateValue);
  expect(JSON.parse(line)).toMatchObject({
    stage: "unknown",
    outcome: "pending",
  });
  expect(JSON.parse(line)).not.toHaveProperty("user_id");
  work.resolve();
  await result;
});

it("attributes the first title wait separately from settlement in every finishing caller", async () => {
  const filename = path.resolve(__dirname, "../chat-handler.ts");
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const initializers: ts.CallExpression[] = [];
  const usageCalls: ts.Expression[] = [];
  let usageHelper: ts.ArrowFunction | undefined;
  const walk = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "deductAccumulatedUsage" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    )
      usageHelper = node.initializer;
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(source) === "createChatFinishObserver")
        initializers.push(node);
      if (node.expression.getText(source) === "deductAccumulatedUsage") {
        let parent: ts.Node = node.parent;
        if (ts.isArrowFunction(parent) && ts.isCallExpression(parent.parent))
          parent = parent.parent.parent;
        if (ts.isAwaitExpression(parent)) usageCalls.push(parent.expression);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  expect(initializers).toHaveLength(1);
  expect(usageCalls).toHaveLength(3);
  expect(usageHelper).toBeDefined();
  const phases: string[] = [];
  for (const call of usageCalls) {
    warn.mockClear();
    const title = deferred<string>();
    const sandbox = deferred<{ totalCostDollars: number }>();
    const observeFinish = vm.runInNewContext(initializers[0].getText(source), {
      createChatFinishObserver,
      ...context,
    });
    const releaseFreeRunLockOnce = jest.fn(async () => {});
    const helperText = ts.transpile(`(${usageHelper!.getText(source)})`);
    const deductAccumulatedUsage = vm.runInNewContext(helperText, {
      observeFinish,
      titlePromise: title.promise,
      assistantMessageId: "assistant",
      hasRecordedUsage: false,
      getSandboxSessionUsage: () => sandbox.promise,
      usageTracker: { hasUsage: false },
      paidDailyFreeAllowanceReservation: null,
      releaseFreeRunLockOnce,
    });
    const pending = vm.runInNewContext(call.getText(source), {
      observeFinish,
      deductAccumulatedUsage,
      retryMessageId: "retry",
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
      stage: "wait_title_generation",
      warning_index: 1,
    });
    phases.push(JSON.parse(warn.mock.calls[0][0] as string).phase);
    title.resolve("title");
    await jest.advanceTimersByTimeAsync(10_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(warn.mock.calls[1][0] as string)).toMatchObject({
      stage: "settle_usage",
      warning_index: 2,
    });
    sandbox.resolve({ totalCostDollars: 0 });
    await expect(pending).resolves.toBeUndefined();
    expect(releaseFreeRunLockOnce).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  }
  expect(phases.sort()).toEqual(["primary", "primary", "provider_retry"]);
});
