import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

// Execute the installed worker's actual reset, completion block, FLUSH handler and
// flush helpers in one module-like scope. Only SDK I/O, the tracer and singleton
// managers are controlled, so receipts reflect the real handler order and state.
const cli = realpathSync("node_modules/trigger.dev");
const source = readFileSync(
  process.env.CHILD_FLUSH_WORKER_SOURCE ||
    join(cli, "dist/esm/entryPoints/managed-run-worker.js"),
  "utf8",
);
const sf = ts.createSourceFile(
  "worker.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const functions = [
  "resetExecutionEnvironment",
  "flushAll",
  "flushUsage",
  "flushTracingSDK",
  "flushMetadata",
];
const found = new Map();
const record = (key, text) => found.set(key, [...(found.get(key) ?? []), text]);
/** Collect each worker boundary so a missing or duplicated one fails loudly. */
function visit(node) {
  if (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text))
    record(node.name.text, node.getText(sf));
  else if (
    ts.isTryStatement(node) &&
    node.finallyBlock
      ?.getText(sf)
      .includes("standardHeartbeatsManager.stopHeartbeat()")
  )
    record("completion", node.getText(sf));
  else if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "FLUSH")
    record("FLUSH", node.initializer.getText(sf));
  ts.forEachChild(node, visit);
}
visit(sf);
const part = (key) => {
  const texts = found.get(key) ?? [];
  assert.equal(texts.length, 1, `exactly one worker ${key}`);
  return texts[0];
};
const { createChildCompletionProbe } = await import(
  pathToFileURL(join(cli, "dist/esm/entryPoints/child-completion-probe.js"))
);
const instantiate = new Function(
  "h",
  `
 const { standardLocalsManager, standardLifecycleHooksManager, standardRunTimelineMetricsManager, usage, timeout, runMetadataManager, waitUntilManager, standardRealtimeStreamsManager, standardInputStreamManager, standardSessionStreamManager, durableClock, taskContext, standardTraceContextManager, standardHeartbeatsManager, resetIdempotencyKeyCatalog, waitUntil, promiseWithResolvers, setTimeout, resourceCatalog, NO_FILE_CONTEXT, getNumberEnvVar, tracer, process, console, createChildCompletionProbe } = h;
 let _execution, _isRunning = false, _isCancelled = false, _tracingSDK = h.tracingSDK, _executionMeasurement, _cancelController = new AbortController(), _lastFlushPromise, _sharedWorkerRuntime, _parentFlushReceipt;
 ${functions.map(part).join("\n")}
 const FLUSH = ${part("FLUSH")};
 async function complete(execution, executor, ctx, sender) {
  let completionProbe;
  ${part("completion")}
 }
 return {
  reset: resetExecutionEnvironment, complete, FLUSH,
  lastFlush: () => _lastFlushPromise,
  setRunning: (v) => { _isRunning = v; },
  setCancelled: (v) => { _isCancelled = v; },
 };
`,
);

const RECEIPT = "parent flush request received";
const KEY = "hackerai.child_completion.";
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(setImmediate);
const count = (w, event) => w.events.filter((e) => e === event).length;

/** Build one worker scope with recorded I/O and tracer boundaries. */
function worker() {
  const events = [],
    spans = [],
    packets = [];
  let parent;
  const noop = { reset() {} };
  const h = {
    faults: {},
    receiptStarts: 0,
    standardLocalsManager: noop,
    standardLifecycleHooksManager: noop,
    standardRunTimelineMetricsManager: noop,
    waitUntilManager: noop,
    standardRealtimeStreamsManager: noop,
    standardInputStreamManager: noop,
    standardSessionStreamManager: noop,
    durableClock: noop,
    resetIdempotencyKeyCatalog() {},
    waitUntil: { register() {} },
    usage: {
      start: () => ({}),
      stop: () => ({ cpuTime: 123 }),
      reset() {},
      flush() {
        events.push("usage_flush");
        return h.flushGate?.promise;
      },
    },
    timeout: { reset() {}, abortAfterTimeout: () => new AbortController() },
    runMetadataManager: {
      reset() {},
      startPeriodicFlush() {},
      stopAndReturnLastFlush: () =>
        h.metadata?.promise ?? { private: "PRIVATE_METADATA_CANARY" },
      flush() {
        events.push("metadata_flush");
      },
    },
    tracingSDK: {
      flush() {
        events.push("sdk_flush");
      },
    },
    taskContext: {
      disable() {
        events.push("disable_context");
      },
    },
    standardTraceContextManager: {
      reset() {
        parent = undefined;
      },
      extractContext() {
        if (h.faults.context) throw Error("PRIVATE_CONTEXT_CANARY");
        return parent;
      },
      set traceContext(name) {
        parent = { name };
      },
    },
    standardHeartbeatsManager: {
      reset() {},
      startHeartbeat() {},
      stopHeartbeat() {},
    },
    resourceCatalog: {
      setCurrentFileContext() {},
      clearCurrentFileContext() {},
    },
    NO_FILE_CONTEXT: "fixture",
    getNumberEnvVar: (_name, fallback) => fallback,
    promiseWithResolvers: () => Promise.withResolvers(),
    // Timeout races never win; an unresolved promise keeps no timer alive.
    setTimeout: () => new Promise(() => {}),
    process: { connected: true },
    console: { log() {}, error() {} },
    createChildCompletionProbe,
    tracer: {
      startSpan(name, { attributes }, context) {
        if (name === RECEIPT) {
          h.receiptStarts++;
          events.push("receipt_start");
        }
        if (h.faults.tracer) throw Error("PRIVATE_TRACER_CANARY");
        const span = {
          name,
          attributes: { ...attributes },
          context,
          ended: false,
          setAttribute(k, v) {
            this.attributes[k] = v;
          },
          end() {
            if (h.faults.span) throw Error("PRIVATE_SPAN_CANARY");
            this.ended = true;
            if (name === RECEIPT) events.push("receipt_end");
          },
        };
        spans.push(span);
        return span;
      },
    },
  };
  const w = instantiate(h);
  return {
    ...w,
    h,
    events,
    spans,
    packets,
    receipts: () => spans.filter((s) => s.name === RECEIPT),
    completionSpans: () => spans.filter((s) => s.name !== RECEIPT),
  };
}

/** Mirror EXECUTE's reset and trace setup, then run the actual completion block. */
function execute(
  w,
  {
    task = "agent-long",
    trace = task,
    attempt = 1,
    result = { ok: true, output: "PRIVATE_RESULT_CANARY" },
    gate,
    running = true,
    cancelled = false,
    executorError,
    send,
    sendThrow,
  } = {},
) {
  w.reset();
  w.h.standardTraceContextManager.traceContext = trace;
  const execution = {
    task: { id: task },
    run: { id: "PRIVATE_RUN_CANARY", maxDuration: 30 },
    attempt: { number: attempt },
  };
  const executor = {
    async execute() {
      await gate?.promise;
      w.setRunning(running);
      w.setCancelled(cancelled);
      if (executorError) throw executorError;
      return { result };
    },
  };
  const sender = {
    send(kind, packet) {
      w.packets.push({ kind, packet });
      if (sendThrow) throw sendThrow;
      return send?.promise ?? Promise.resolve();
    },
  };
  return w.complete(execution, executor, {}, sender);
}

/** Expected receipt attributes; undefined overrides mean the field is omitted. */
function receiptOf(phase, overrides = {}) {
  const attributes = {
    version: 1,
    association: "current_child_context",
    phase,
    disable_context: true,
    worker_running: false,
    worker_cancelled: false,
    process_connected: true,
    result_ok: true,
    attempt: 1,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [KEY + key, value]),
  );
}
const flush = (w, disableContext = true) =>
  w.FLUSH({ timeoutInMs: 1000, disableContext });

test("completion cleanup FLUSH ends one live receipt before the original flush exports", async () => {
  const w = worker();
  await execute(w);
  // Live values at FLUSH entry, not the completion-time snapshot.
  w.h.process.connected = false;
  w.events.length = 0;
  const flushed = flush(w);
  assert.deepEqual(w.events, [
    "receipt_start",
    "receipt_end",
    "usage_flush",
    "sdk_flush",
    "metadata_flush",
  ]);
  assert.equal(await flushed, undefined);
  assert.deepEqual(w.events.slice(-1), ["disable_context"]);
  assert.equal(w.receipts().length, 1);
  const [receipt] = w.receipts();
  assert.ok(receipt.ended);
  assert.deepEqual(
    receipt.attributes,
    receiptOf("returned_unacknowledged", { process_connected: false }),
  );
  // Parent captured at probe creation is the completed execution's root.
  assert.equal(receipt.context, w.completionSpans()[0].context);
  assert.equal(receipt.context.name, "agent-long");
  assert.deepEqual(
    w
      .completionSpans()
      .map((s) => [
        s.attributes[`${KEY}outcome`],
        s.attributes[`${KEY}process_connected`],
      ]),
    [
      ["packet_ready", true],
      ["returned_unacknowledged", true],
    ],
  );
  assert.equal(w.packets.length, 1);
  assert.doesNotMatch(JSON.stringify(w.spans), /PRIVATE_/);
});

test("FLUSH before any completion probe emits nothing and keeps the original flush", async () => {
  const w = worker();
  await flush(w);
  const gate = deferred();
  const done = execute(w, { gate });
  await tick();
  w.events.length = 0;
  // Suspension while the task still runs: no probe exists yet.
  assert.equal(await flush(w, false), undefined);
  assert.deepEqual(w.events, ["usage_flush", "sdk_flush", "metadata_flush"]);
  assert.equal(w.h.receiptStarts, 0);
  assert.equal(w.spans.length, 0);
  gate.resolve();
  await done;
  await flush(w);
  assert.equal(w.receipts().length, 1);
  assert.equal(
    w.receipts()[0].attributes[`${KEY}phase`],
    "returned_unacknowledged",
  );
});

test("FLUSH after probe creation but before the packet is the ambiguity control, not completion", async () => {
  const w = worker();
  w.h.metadata = deferred();
  const done = execute(w);
  await tick();
  await flush(w, false);
  assert.equal(w.receipts().length, 1);
  assert.deepEqual(
    w.receipts()[0].attributes,
    receiptOf("packet_pending", {
      disable_context: false,
      worker_running: true,
    }),
  );
  assert.equal(
    Object.hasOwn(w.receipts()[0].attributes, `${KEY}outcome`),
    false,
  );
  w.h.metadata.resolve({ private: "PRIVATE_METADATA_CANARY" });
  await done;
  assert.equal(w.packets.length, 1);
  assert.deepEqual(
    w.completionSpans().map((s) => s.attributes[`${KEY}outcome`]),
    ["packet_ready", "returned_unacknowledged"],
  );
  await flush(w);
  assert.equal(w.h.receiptStarts, 1);
});

for (const fault of [undefined, "tracer", "span"])
  test(`repeated and concurrent FLUSH${fault ? ` with ${fault} fault` : ""} attempt one receipt and run every original flush`, async () => {
    const w = worker();
    await execute(w);
    if (fault) w.h.faults[fault] = true;
    w.events.length = 0;
    w.h.flushGate = deferred();
    const first = flush(w);
    const second = flush(w);
    const latest = w.lastFlush();
    let latestSettled = false;
    latest.then(() => (latestSettled = true));
    await tick();
    // EXECUTE still waits on the latest pending flush.
    assert.equal(latestSettled, false);
    assert.equal(w.h.receiptStarts, 1);
    assert.equal(count(w, "usage_flush"), 2);
    w.h.flushGate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      undefined,
      undefined,
    ]);
    await latest;
    assert.equal(await flush(w), undefined);
    assert.equal(w.h.receiptStarts, 1);
    assert.equal(count(w, "usage_flush"), 3);
    assert.equal(count(w, "disable_context"), 3);
    assert.equal(w.receipts().filter((s) => s.ended).length, fault ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(w.spans), /PRIVATE_/);
  });

for (const [name, setup, phase, overrides] of [
  ["sent", {}, "returned_unacknowledged"],
  ["send pending", { send: "pending" }, "packet_ready"],
  ["send rejected", { send: "reject" }, "rejected"],
  ["send throws", { sendThrow: true }, "invocation_error"],
  ["metadata rejects", { metadata: true }, "packet_error"],
  [
    "cancelled guard",
    { cancelled: true },
    "cancelled_guard",
    { worker_cancelled: true },
  ],
  ["not running guard", { running: false }, "not_running_guard"],
  [
    "failed result",
    { result: { ok: false, error: "PRIVATE_ERROR_CANARY" } },
    "returned_unacknowledged",
    { result_ok: false },
  ],
  ["executor throws", { executorError: true }, null],
  ["non-Agent task", { task: "health-probe" }, null],
  ["context fault", { context: true }, null],
])
  test(`${name}: FLUSH receipt reports ${phase ?? "nothing"}`, async () => {
    const error = Error("PRIVATE_ERROR_CANARY");
    const send = deferred();
    const w = worker();
    if (setup.metadata) w.h.metadata = deferred();
    w.h.faults.context = setup.context === true;
    const done = execute(w, {
      ...setup,
      send: setup.send ? send : undefined,
      sendThrow: setup.sendThrow ? error : undefined,
      executorError: setup.executorError ? error : undefined,
    });
    const settled = done.then(
      () => "resolved",
      (e) => {
        assert.equal(e, error);
        return "rejected";
      },
    );
    await tick();
    if (setup.send === "reject") send.reject(error);
    if (setup.metadata) w.h.metadata.reject(error);
    if (setup.send !== "pending") await settled;
    else await tick();
    await flush(w);
    assert.equal(count(w, "usage_flush"), 1);
    if (!phase) {
      assert.equal(w.h.receiptStarts, 0);
      return;
    }
    assert.equal(w.receipts().length, 1);
    assert.deepEqual(w.receipts()[0].attributes, receiptOf(phase, overrides));
    assert.doesNotMatch(JSON.stringify(w.spans), /PRIVATE_/);
  });

test("warm Agent A, non-Agent B, Agent C: reset fences A and C reports only its own root", async () => {
  const w = worker();
  // A completes and its receipt is never consumed.
  await execute(w, { trace: "A" });
  const gate = deferred();
  const b = execute(w, { task: "health-probe", trace: "B", gate });
  await tick();
  // Pre-probe suspension FLUSH for B must not surface A's receipt.
  await flush(w, false);
  assert.equal(w.h.receiptStarts, 0);
  gate.resolve();
  await b;
  await flush(w);
  assert.equal(w.h.receiptStarts, 0);
  await execute(w, { trace: "C", attempt: 2 });
  await flush(w);
  assert.equal(w.receipts().length, 1);
  assert.equal(w.receipts()[0].context.name, "C");
  assert.equal(w.receipts()[0].attributes[`${KEY}attempt`], 2);
});

test("late completion of a replaced execution cannot register under the newer EXECUTE", async () => {
  const w = worker();
  const gate = deferred();
  const late = execute(w, { trace: "A", gate });
  await tick();
  // A newer EXECUTE resets the environment before A's executor returns.
  w.reset();
  w.h.standardTraceContextManager.traceContext = "B";
  gate.resolve();
  await late;
  assert.equal(w.packets.length, 1);
  await flush(w);
  assert.equal(w.h.receiptStarts, 0);
});

test("hostile values are reduced to strict booleans and omitted attempts", async () => {
  const w = worker();
  await execute(w, {
    attempt: "PRIVATE_ATTEMPT_CANARY",
    result: { ok: "true", output: "PRIVATE_RESULT_CANARY" },
  });
  w.h.process.connected = "PRIVATE_CONNECTED_CANARY";
  w.events.length = 0;
  await flush(w, "PRIVATE_FLUSH_CANARY");
  assert.deepEqual(
    w.receipts()[0].attributes,
    receiptOf("returned_unacknowledged", {
      disable_context: false,
      process_connected: false,
      result_ok: false,
      attempt: undefined,
    }),
  );
  // The original truthy check still disables context.
  assert.equal(count(w, "disable_context"), 1);
  assert.doesNotMatch(JSON.stringify(w.spans), /PRIVATE_/);
});
