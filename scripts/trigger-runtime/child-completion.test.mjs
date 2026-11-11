import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

// Execute the installed CLI's real completion try/catch/finally, with its
// executor/metadata/IPC boundaries controlled. These assertions protect the
// packet, original error identity, and cleanup timing, not a copy of that code.
const cli = realpathSync("node_modules/trigger.dev");
const baseline = process.env.CHILD_COMPLETION_BASELINE;
const source = readFileSync(
  baseline || join(cli, "dist/esm/entryPoints/managed-run-worker.js"),
  "utf8",
);
const sf = ts.createSourceFile(
  "worker.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let completion;
function visit(node) {
  if (
    ts.isTryStatement(node) &&
    node.finallyBlock
      ?.getText(sf)
      .includes("standardHeartbeatsManager.stopHeartbeat()")
  )
    completion = node.getText(sf);
  ts.forEachChild(node, visit);
}
visit(sf);
assert.ok(completion, "real worker completion boundary exists");
const inert = {
  packetReady: (packet) => packet,
  observeReturn() {},
  skipped() {},
  failed() {},
};
const { createChildCompletionProbe } = baseline
  ? { createChildCompletionProbe: () => inert }
  : await import(
      pathToFileURL(join(cli, "dist/esm/entryPoints/child-completion-probe.js"))
    );
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  "h",
  `
 const { execution, executor, ctx, standardHeartbeatsManager, runMetadataManager, usage, timeout, _cancelController, resourceCatalog, NO_FILE_CONTEXT, sender, tracer, standardTraceContextManager, process, console, createChildCompletionProbe } = h;
 let _execution, _isRunning=false, _isCancelled=false, _executionMeasurement, completionProbe;
 const getNumberEnvVar = (_name, fallback) => fallback;
 const signalState = { setRunning: (v) => _isRunning=v, setCancelled: (v) => _isCancelled=v };
 h.state=signalState;
 ${completion}
`,
);
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(setImmediate);
function fixture({
  metadata,
  send,
  task = "agent-long",
  running = true,
  cancelled = false,
  connected = true,
  tracerFault = false,
  spanFault = false,
  contextFault = false,
  sendThrow,
  executorError,
  attempt = 1,
} = {}) {
  const events = [],
    spans = [],
    packets = [];
  const result = {
    ok: true,
    output: "PRIVATE_RESULT_CANARY",
    secret: "PRIVATE_RESULT_CANARY",
  };
  const parent = {};
  const h = {
    execution: {
      task: { id: task },
      run: { id: "run_test", maxDuration: 30 },
      attempt: { number: attempt },
    },
    ctx: {},
    executor: {
      async execute() {
        events.push("execute");
        h.state.setRunning(running);
        h.state.setCancelled(cancelled);
        if (executorError) throw executorError;
        return { result };
      },
    },
    standardHeartbeatsManager: {
      startHeartbeat() {
        events.push("heartbeat_start");
      },
      stopHeartbeat() {
        events.push("heartbeat_stop");
      },
    },
    runMetadataManager: {
      startPeriodicFlush() {},
      stopAndReturnLastFlush() {
        events.push("metadata");
        return metadata?.promise ?? { private: "PRIVATE_METADATA_CANARY" };
      },
    },
    usage: {
      start() {
        return {};
      },
      stop() {
        events.push("usage_stop");
        return { cpuTime: 123 };
      },
    },
    timeout: {
      abortAfterTimeout() {
        return new AbortController();
      },
    },
    _cancelController: new AbortController(),
    resourceCatalog: {
      setCurrentFileContext() {},
      clearCurrentFileContext() {
        events.push("clear");
      },
    },
    NO_FILE_CONTEXT: "fixture",
    sender: {
      get send() {
        events.push("send_lookup");
        return (kind, packet) => {
          events.push("send");
          packets.push({ kind, packet });
          if (sendThrow) throw sendThrow;
          return send?.promise ?? Promise.resolve();
        };
      },
    },
    tracer: {
      startSpan(name, { attributes }, context) {
        if (tracerFault) throw Error("PRIVATE_TRACER_CANARY");
        assert.equal(context, parent);
        const span = {
          name,
          attributes: { ...attributes },
          ended: false,
          setAttribute(k, v) {
            if (spanFault) throw Error("PRIVATE_SPAN_CANARY");
            this.attributes[k] = v;
          },
          end() {
            if (spanFault) throw Error("PRIVATE_SPAN_CANARY");
            this.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
    },
    standardTraceContextManager: {
      extractContext() {
        if (contextFault) throw Error("PRIVATE_CONTEXT_CANARY");
        return parent;
      },
    },
    process: { connected },
    console: {
      log() {
        events.push("completion_log");
      },
    },
    createChildCompletionProbe,
  };
  return { h, events, spans, packets, result, run: () => execute(h) };
}
const outcomes = (f) =>
  f.spans.map((s) => s.attributes["hackerai.child_completion.outcome"]);
const businessEvents = (f) => f.events;
const successfulOrder = [
  "heartbeat_start",
  "execute",
  "usage_stop",
  "send_lookup",
  "metadata",
  "send",
  "heartbeat_stop",
  "clear",
  "completion_log",
];

test("normal completion keeps the exact packet and two unacknowledged child observations", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(businessEvents(f), successfulOrder);
  assert.equal(f.packets.length, 1);
  assert.equal(f.packets[0].kind, "TASK_RUN_COMPLETED");
  assert.deepEqual(f.packets[0].packet, {
    execution: f.h.execution,
    result: {
      ...f.result,
      usage: { durationMs: 123 },
      flushedMetadata: { private: "PRIVATE_METADATA_CANARY" },
    },
  });
  assert.deepEqual(outcomes(f), ["packet_ready", "returned_unacknowledged"]);
  assert.ok(f.spans.every((s) => s.ended));
  assert.doesNotMatch(
    JSON.stringify(f.spans),
    /PRIVATE_|ACKED|received|accepted/,
  );
});

test("metadata pending keeps packet span open and heartbeat alive; IPC pending does not delay finally", async () => {
  const metadata = deferred(),
    send = deferred(),
    f = fixture({ metadata, send });
  const done = f.run();
  await tick();
  assert.deepEqual(f.events, [
    "heartbeat_start",
    "execute",
    "usage_stop",
    "send_lookup",
    "metadata",
  ]);
  assert.equal(f.spans.length, 1);
  assert.equal(f.spans[0].ended, false);
  metadata.resolve({ private: "PRIVATE_METADATA_CANARY" });
  await tick();
  assert.deepEqual(f.events, successfulOrder);
  assert.deepEqual(outcomes(f), ["packet_ready", undefined]);
  assert.equal(f.spans[1].ended, false);
  let settled = false;
  done.then(() => (settled = true));
  await tick();
  assert.equal(settled, false);
  send.resolve();
  await done;
  assert.deepEqual(outcomes(f), ["packet_ready", "returned_unacknowledged"]);
});
for (const [name, options, outcome] of [
  ["cancelled", { cancelled: true }, "cancelled_guard"],
  ["not running", { running: false }, "not_running_guard"],
])
  test(`${name} guard emits one bounded outcome without metadata or IPC`, async () => {
    const f = fixture(options);
    await f.run();
    assert.deepEqual(f.events, [
      "heartbeat_start",
      "execute",
      "heartbeat_stop",
      "clear",
      "completion_log",
    ]);
    assert.equal(f.packets.length, 0);
    assert.deepEqual(outcomes(f), [outcome]);
  });
for (const phase of [
  "metadata",
  "send synchronous",
  "send asynchronous",
  "executor",
])
  test(`${phase} rejection retains original identity and cleanup`, async () => {
    const error = Error("PRIVATE_ERROR_CANARY");
    const metadata = deferred(),
      send = deferred();
    const f = fixture(
      phase === "metadata"
        ? { metadata }
        : phase === "send synchronous"
          ? { sendThrow: error }
          : phase === "send asynchronous"
            ? { send }
            : { executorError: error },
    );
    const done = f.run();
    const rejected = assert.rejects(done, (e) => e === error);
    await tick();
    if (phase === "metadata") metadata.reject(error);
    if (phase === "send asynchronous") send.reject(error);
    await rejected;
    assert.deepEqual(f.events.slice(-3), [
      "heartbeat_stop",
      "clear",
      "completion_log",
    ]);
    assert.equal(f.events.filter((e) => e === "execute").length, 1);
    assert.equal(
      f.events.filter((e) => e === "send").length,
      phase.startsWith("send") ? 1 : 0,
    );
    const expected =
      phase === "metadata"
        ? ["packet_error"]
        : phase === "send synchronous"
          ? ["packet_ready", "invocation_error"]
          : phase === "send asynchronous"
            ? ["packet_ready", "rejected"]
            : [];
    assert.deepEqual(outcomes(f), expected);
    assert.doesNotMatch(JSON.stringify(f.spans), /PRIVATE_/);
  });
for (const fault of ["tracerFault", "spanFault", "contextFault"])
  test(`${fault} cannot break normal completion`, async () => {
    const f = fixture({ [fault]: true });
    await f.run();
    assert.deepEqual(f.events, successfulOrder);
    assert.equal(f.packets.length, 1);
  });
test("disconnected IPC fulfillment is explicitly unacknowledged", async () => {
  const f = fixture({ connected: false });
  await f.run();
  assert.equal(
    f.spans[1].attributes["hackerai.child_completion.process_connected"],
    false,
  );
  assert.deepEqual(outcomes(f), ["packet_ready", "returned_unacknowledged"]);
});
test("non-Agent tasks keep completion behavior with zero new spans", async () => {
  const f = fixture({ task: "health-probe" });
  await f.run();
  assert.deepEqual(f.events, successfulOrder);
  assert.equal(f.spans.length, 0);
});
for (const attempt of [
  NaN,
  Infinity,
  -1,
  0,
  1.5,
  1000001,
  "PRIVATE_ATTEMPT_CANARY",
])
  test(`invalid attempt ${String(attempt)} is omitted`, async () => {
    const f = fixture({ attempt });
    await f.run();
    assert.equal(f.spans.length, 2);
    for (const s of f.spans)
      assert.equal(
        Object.hasOwn(s.attributes, "hackerai.child_completion.attempt"),
        false,
      );
  });

for (const mode of ["0", "1"])
  test(`actual SDK ${mode === "1" ? "Batch" : "Simple"} export keeps run parentage after Attempt and warm reset`, () => {
    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./child-completion-export.fixture.mjs", import.meta.url),
        ),
      ],
      {
        env: { ...process.env, TRIGGER_OTEL_BATCH_PROCESSING_ENABLED: mode },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    const receipt = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(receipt.pass, true);
    assert.equal(receipt.cases, 4);
  });
