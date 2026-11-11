import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {
  HELPER_PATH,
  MARKER,
  WORKER_SOURCE,
  createWorker,
  parentTerminalFromPacket,
  parseS2UncaughtTrailer,
  readS2UncaughtTerminal,
  runIpcCase,
  serverWorker,
  syntheticExecution,
  taskContext,
  workerParts,
} from "./s2-uncaught-ipc.fixture.mjs";

// These tests run the worker's actual uncaught handler, safeSend, reset and
// EXECUTE handler (see the fixture), then the parent's actual schema, CLI
// parseExecuteError and core sanitizer. S2_UNCAUGHT_WORKER_SOURCE=<older
// managed-run-worker.js> is the baseline proof: positive cases fail, while
// controls that require the exact original payload still pass.
const S2_FRAME =
  "    at s2Error (file:///app/node_modules/@s2-dev/streamstore/dist/esm/error.js:78:16)";
const APP_FRAME = "    at pipe (file:///app/trigger/agent-long.js:1:1)";
const tick = () => new Promise(setImmediate);

/** A synthetic S2 stack: header, optional pre-frame lines, an S2 frame, then app frames. */
function s2Stack({
  message = "Connection failed: ECONNRESET",
  head = [],
  frames = 3,
  s2 = true,
} = {}) {
  return [
    `S2Error: ${message}`,
    ...head,
    s2 ? S2_FRAME : APP_FRAME,
    ...Array(frames - 1).fill(APP_FRAME),
  ].join("\n");
}
/** An Error carrying S2Error's own data fields; `undefined` options are left absent. */
function s2Error({
  name = "S2Error",
  message = "Connection failed: ECONNRESET",
  stack = s2Stack({ message }),
  ...fields
} = {}) {
  const error = new Error(message);
  const values = { status: 502, code: "ECONNRESET", origin: "sdk", ...fields };
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) error[key] = value;
  Object.defineProperty(error, "name", { value: name, configurable: true });
  Object.defineProperty(error, "stack", { value: stack, configurable: true });
  return error;
}

/** A worker whose task body stays pending until `finish()`. */
function worker() {
  let body;
  const w = createWorker({
    run: async (execution) => {
      body = Promise.withResolvers();
      await body.promise;
      return {
        result: {
          ok: true,
          id: execution.run.id,
          output: "{}",
          outputType: "application/json",
        },
      };
    },
    metadata: () => w.metadata?.promise,
  });
  w.packets = [];
  const sender = {
    send: async (type, packet) => {
      w.packets.push({ type, packet });
    },
  };
  w.start = async (options) => {
    const done = w.EXECUTE_TASK_RUN(
      {
        execution: syntheticExecution(options),
        traceContext: {},
        metadata: serverWorker,
        metrics: [],
        isWarmStart: false,
      },
      sender,
    );
    await tick();
    const finish = async () => {
      body.resolve();
      await done;
    };
    return { done, finish };
  };
  return w;
}
const errorOf = (packet) => packet.message.payload.error;
/** One packet whose serialized error is exactly the handler's original read. */
function assertOriginal(packets, error) {
  assert.equal(packets.length, 1);
  assert.equal(
    JSON.stringify(errorOf(packets[0])),
    JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
    }),
  );
}
/** One packet with the original name/message and stack prefix plus one bounded trailer. */
function assertTrailer(packets, error) {
  assert.equal(packets.length, 1);
  const serialized = errorOf(packets[0]);
  assert.deepEqual(Object.keys(serialized), ["name", "message", "stack"]);
  assert.equal(serialized.name, error.name);
  assert.equal(serialized.message, error.message);
  const read = parseS2UncaughtTrailer(serialized.stack);
  assert.equal(read.kind, "valid", read.reason);
  assert.equal(read.prefix, error.stack);
  assert.ok(
    Buffer.byteLength(serialized.stack.slice(error.stack.length)) <= 1024,
  );
  assert.doesNotMatch(serialized.stack.slice(error.stack.length), /PRIVATE/);
  return read.fields;
}
/** Fire `error` during a running Agent EXECUTE and return the trailer fields. */
async function fieldsFor(error, { origin, attempt, setup } = {}) {
  const w = worker();
  const run = await w.start({ attempt });
  setup?.(w);
  const fields = assertTrailer(w.fire(error, origin), error);
  await run.finish();
  return fields;
}
const baseFields = {
  version: 1,
  association: "current_child_context",
  phase: "execution_active",
  node_origin: "uncaughtException",
  status: 502,
  code: "ECONNRESET",
  property_origin: "sdk",
  max_attempt_exhausted: false,
  worker_running: true,
  worker_cancelled: false,
  process_connected: true,
  attempt: 1,
};
/** Accessor or inherited S2 fields are not own data, so they classify as absent. */
const { status: _omitted, ...absentFields } = {
  ...baseFields,
  code: "other_or_absent",
  property_origin: "other_or_absent",
};

test("eligible current Agent S2Error keeps console order, payload keys and terminal fields, adding one trailer", async () => {
  const w = worker();
  const run = await w.start();
  const error = s2Error();
  const packets = w.fire(error);
  assert.deepEqual(
    w.events.map((e) => e.kind),
    ["console.error", "send"],
  );
  assert.equal(w.events[0].label, "Uncaught exception");
  assert.equal(w.events[0].detail.error, error);
  assert.equal(w.events[0].detail.origin, "uncaughtException");
  const [packet] = packets;
  assert.deepEqual(Object.keys(packet), ["type", "message"]);
  assert.deepEqual(Object.keys(packet.message), ["type", "payload", "version"]);
  assert.deepEqual(Object.keys(packet.message.payload), ["error", "origin"]);
  assert.equal(packet.type, "EVENT");
  assert.equal(packet.message.type, "UNCAUGHT_EXCEPTION");
  assert.equal(packet.message.version, "v1");
  assert.equal(packet.message.payload.origin, "uncaughtException");
  assert.deepEqual(assertTrailer(packets, error), baseFields);
  // Actual parent schema, UncaughtExceptionError, parseExecuteError and sanitizer.
  assert.deepEqual(await parentTerminalFromPacket(packet), {
    type: "INTERNAL_ERROR",
    code: "TASK_RUN_UNCAUGHT_EXCEPTION",
    message: error.message,
    stackTrace: errorOf(packet).stack,
  });
  await run.finish();
  assert.equal(w.packets.length, 1);
});

test("Error name/message/stack getters run once each; status/code/origin accessors never run; the Error is unchanged", async () => {
  const w = worker();
  const run = await w.start();
  const reads = {};
  const error = new Error("unused");
  const values = {
    name: "S2Error",
    message: "Connection failed: ECONNRESET",
    stack: s2Stack(),
    status: 502,
    code: "ECONNRESET",
    origin: "sdk",
  };
  for (const [key, value] of Object.entries(values)) {
    reads[key] = 0;
    Object.defineProperty(error, key, {
      get() {
        reads[key]++;
        return value;
      },
      configurable: true,
    });
  }
  const snapshot = () =>
    Reflect.ownKeys(error).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(error, key),
    ]);
  const before = snapshot();
  const [packet] = w.fire(error);
  assert.deepEqual(reads, {
    name: 1,
    message: 1,
    stack: 1,
    status: 0,
    code: 0,
    origin: 0,
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(w.events[0].detail.error, error);
  assert.equal(errorOf(packet).message, values.message);
  const read = parseS2UncaughtTrailer(errorOf(packet).stack);
  assert.equal(read.kind, "valid");
  assert.equal(read.prefix, values.stack);
  assert.deepEqual(read.fields, absentFields);
  await run.finish();
});

const kib16 = 16 * 1024;
const longLines = (count, char = "x") =>
  Array(count).fill(`    ${char.repeat(1000)}`);
const ineligible = [
  ["non-S2 name", s2Error({ name: "Error" })],
  ["S2 subclass name", s2Error({ name: "SeqNumMismatchError" })],
  ["no S2 frame", s2Error({ stack: s2Stack({ s2: false }) })],
  [
    "S2 path only in the message line",
    s2Error({
      message: "see @s2-dev/streamstore/x",
      stack: s2Stack({ message: "see @s2-dev/streamstore/x", s2: false }),
    }),
  ],
  ["NUL in stack", s2Error({ stack: `${s2Stack()}\0` })],
  ["already marked", s2Error({ stack: `${s2Stack()}\n${MARKER} {}` })],
  [
    "marker token in message",
    s2Error({
      message: "hackerai.s2_uncaught",
      stack: s2Stack({ message: "x" }),
    }),
  ],
  ["over 16 KiB", s2Error({ stack: s2Stack({ head: longLines(17) }) })],
  [
    "over 16 KiB UTF-8 under 16 Ki chars",
    s2Error({ stack: s2Stack({ head: longLines(9, "é") }) }),
  ],
  [
    "line over 1024 characters",
    // "    at " is 7 characters: 1025 in total.
    s2Error({ stack: `${s2Stack()}\n    at ${"x".repeat(1018)}` }),
  ],
  [
    "50 lines from the first frame",
    s2Error({ stack: s2Stack({ frames: 50 }) }),
  ],
  [
    "stack not a string",
    Object.defineProperty(s2Error(), "stack", { value: undefined }),
  ],
];
for (const [name, error] of ineligible)
  test(`ineligible snapshot (${name}) keeps the exact original payload`, async () => {
    const w = worker();
    const run = await w.start();
    assertOriginal(w.fire(error), error);
    await run.finish();
  });

test("non-string message keeps the exact original payload", async () => {
  const w = worker();
  const run = await w.start();
  const error = s2Error();
  Object.defineProperty(error, "message", { value: 42 });
  assertOriginal(w.fire(error), error);
  await run.finish();
});

/** Pad pre-frame lines so the whole stack is exactly `bytes` UTF-8 bytes. */
function stackOfBytes(bytes) {
  const base = s2Stack();
  const head = [];
  let remaining = bytes - Buffer.byteLength(base);
  while (remaining > 0) {
    const size = Math.min(1000, remaining - 1);
    head.push("x".repeat(size));
    remaining -= size + 1;
  }
  return s2Stack({ head });
}
const boundaries = [
  ["49 lines from the first frame", s2Stack({ frames: 49 })],
  ["a 1024-character line", `${s2Stack()}\n    at ${"x".repeat(1017)}`],
  ["exactly 16 KiB", stackOfBytes(kib16)],
  [
    "Unicode message",
    s2Stack({ message: "Échec 接続 \u{1F6A8} \u{10FFFF}", head: ["  ✓ ä"] }),
  ],
];
for (const [name, stack] of boundaries)
  test(`boundary (${name}) appends a trailer that survives the actual sanitizer byte-for-byte`, async () => {
    if (name === "exactly 16 KiB")
      assert.equal(Buffer.byteLength(stack), kib16);
    const w = worker();
    const run = await w.start();
    const error = s2Error({ stack });
    const [packet] = w.fire(error);
    assertTrailer([packet], error);
    const terminal = await parentTerminalFromPacket(packet);
    assert.equal(terminal.message, error.message);
    assert.equal(terminal.stackTrace, errorOf(packet).stack);
    assert.equal(readS2UncaughtTerminal(terminal).prefix, stack);
    await run.finish();
  });

test("an original the sanitizer would truncate stays undecorated", async () => {
  const w = worker();
  const run = await w.start();
  const error = s2Error({ stack: s2Stack({ frames: 60 }) });
  const [packet] = w.fire(error);
  assertOriginal([packet], error);
  const terminal = await parentTerminalFromPacket(packet);
  assert.match(terminal.stackTrace, /frames omitted/);
  assert.equal(readS2UncaughtTerminal(terminal).kind, "absent");
  await run.finish();
});

const contexts = [
  ["before any EXECUTE", async () => ({ w: worker() })],
  [
    "non-Agent execution",
    async () => {
      const w = worker();
      return { w, run: await w.start({ taskId: "health-probe" }) };
    },
  ],
  [
    "after the execution completed",
    async () => {
      const w = worker();
      await (await w.start()).finish();
      return { w };
    },
  ],
  [
    "after reset",
    async () => {
      const w = worker();
      const run = await w.start();
      w.reset();
      return { w, run };
    },
  ],
  [
    "disabled task context",
    async () => {
      const w = worker();
      const run = await w.start();
      taskContext.disable();
      return { w, run };
    },
  ],
  [
    "replaced current execution",
    async () => {
      const w = worker();
      const run = await w.start();
      w.setExecution(syntheticExecution());
      return { w, run };
    },
  ],
  [
    "a new EXECUTE before its first await",
    async () => {
      const w = worker();
      // B's reset later supersedes A, whose orphaned body holds no handle.
      await w.start({ runId: "run_a" });
      const flush = Promise.withResolvers();
      w.setLastFlush(flush.promise);
      const next = w.start({ runId: "run_b" });
      // Run A is still current; only the EXECUTE fence can explain no trailer.
      assert.equal(w.current().run.id, "run_a");
      return { w, later: () => (flush.resolve(), next) };
    },
  ],
];
for (const [name, setup] of contexts)
  test(`${name}: eligible S2Error keeps the exact original payload`, async () => {
    const { w, run, later } = await setup();
    const error = s2Error();
    assertOriginal(w.fire(error), error);
    await (later ? await later() : run)?.finish();
  });

test("one trailer per execution: repeats, an earlier non-S2 event and reentrant events add none", async () => {
  const w = worker();
  const run = await w.start();
  const first = s2Error();
  assertTrailer(w.fire(first), first);
  const second = s2Error();
  assertOriginal(w.fire(second), second);
  await run.finish();

  const consumed = worker();
  const next = await consumed.start();
  const plain = new Error("PRIVATE_PLAIN_CANARY");
  assertOriginal(consumed.fire(plain), plain);
  assertOriginal(consumed.fire(first), first);
  await next.finish();

  const reentrant = worker();
  const third = await reentrant.start();
  const inner = s2Error();
  let nested;
  const outerTarget = s2Error();
  const outer = new Proxy(outerTarget, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "status" && !nested) nested = reentrant.fire(inner);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const packets = reentrant.fire(outer);
  assertOriginal(nested, inner);
  assert.equal(reentrant.process.sent.length, 2);
  assertTrailer(packets.slice(1), outerTarget);
  await third.finish();
});

test("warm EXECUTE gets a fresh probe after the previous one was consumed", async () => {
  const w = worker();
  const a = await w.start({ runId: "run_a" });
  const plain = new Error("PRIVATE_PLAIN_CANARY");
  assertOriginal(w.fire(plain), plain);
  await a.finish();
  const b = await w.start({ runId: "run_b", attempt: 2 });
  const error = s2Error();
  assert.equal(assertTrailer(w.fire(error), error).attempt, 2);
  await b.finish();
});

test("descriptor trap faults return the exact original payload and one send", async () => {
  const w = worker();
  const run = await w.start();
  const target = s2Error();
  const error = new Proxy(target, {
    getOwnPropertyDescriptor() {
      throw new Error("PRIVATE_TRAP_CANARY");
    },
  });
  assertOriginal(w.fire(error), target);
  assert.deepEqual(
    w.events.map((e) => e.kind),
    ["console.error", "send"],
  );
  await run.finish();
});

test("inherited and accessor S2 fields are ignored", async () => {
  const proto = Object.create(Error.prototype, {
    status: { value: 502 },
    code: { value: "ECONNRESET" },
    origin: { value: "server" },
  });
  const inherited = s2Error({
    status: undefined,
    code: undefined,
    origin: undefined,
  });
  Object.setPrototypeOf(inherited, proto);
  assert.deepEqual(await fieldsFor(inherited), absentFields);
});

const statusCases = [
  [0, 0],
  [-0, 0],
  [100, 100],
  [599, 599],
  [99, undefined],
  [600, undefined],
  [502.5, undefined],
  [NaN, undefined],
  [Infinity, undefined],
  ["502", undefined],
  [true, undefined],
  [502n, undefined],
];
for (const [status, expected] of statusCases)
  test(`status ${typeof status} ${String(status)} maps to ${String(expected)}`, async () => {
    const fields = await fieldsFor(s2Error({ status }));
    assert.equal(fields.status, expected);
    assert.equal(Object.hasOwn(fields, "status"), expected !== undefined);
  });

let codeCoercions = 0;
const codeCases = [
  ["ECONNRESET", "ECONNRESET"],
  ["REQUEST_TIMEOUT", "REQUEST_TIMEOUT"],
  ["connection_failed", "connection_failed"],
  ["rate_limited", "rate_limited"],
  ["PRIVATE_CODE_CANARY", "other_or_absent"],
  ["econnreset", "other_or_absent"],
  [42, "other_or_absent"],
  [
    {
      toString: () => {
        codeCoercions++;
        return "ECONNRESET";
      },
    },
    "other_or_absent",
  ],
];
for (const [code, expected] of codeCases)
  test(`code ${typeof code === "object" ? "object" : String(code)} maps to ${expected}`, async () => {
    assert.equal((await fieldsFor(s2Error({ code }))).code, expected);
    assert.equal(codeCoercions, 0);
  });

for (const [origin, expected] of [
  ["server", "server"],
  ["sdk", "sdk"],
  ["PRIVATE_ORIGIN_CANARY", "other_or_absent"],
  [undefined, "other_or_absent"],
])
  test(`property origin ${String(origin)} maps to ${expected}`, async () => {
    const fields = await fieldsFor(s2Error({ origin }));
    assert.equal(fields.property_origin, expected);
  });

for (const [origin, expected] of [
  ["uncaughtException", "uncaughtException"],
  ["unhandledRejection", "unhandledRejection"],
  ["PRIVATE_NODE_ORIGIN_CANARY", "other_or_absent"],
])
  test(`Node origin ${origin} maps to ${expected} and the payload origin is unchanged`, async () => {
    const w = worker();
    const run = await w.start();
    const error = s2Error();
    const packets = w.fire(error, origin);
    assert.equal(packets[0].message.payload.origin, origin);
    assert.equal(assertTrailer(packets, error).node_origin, expected);
    await run.finish();
  });

for (const [message, expected] of [
  ["Max attempts (3) exhausted: connection failed", true],
  ["Max attempts (1000000) exhausted: PRIVATE_TAIL_CANARY", true],
  ["Max attempts exhausted: connection failed", false],
  [" Max attempts (3) exhausted: x", false],
  ["Connection failed: ECONNRESET", false],
])
  test(`max-attempt prefix in "${message.slice(0, 24)}" is ${expected}`, async () => {
    const fields = await fieldsFor(s2Error({ message }));
    assert.equal(fields.max_attempt_exhausted, expected);
  });

for (const [attempt, expected] of [
  [1_000_000, 1_000_000],
  [0, undefined],
  [1.5, undefined],
  ["1", undefined],
  [1_000_001, undefined],
])
  test(`attempt ${String(attempt)} maps to ${String(expected)}`, async () => {
    const fields = await fieldsFor(s2Error(), { attempt });
    assert.equal(fields.attempt, expected);
    assert.equal(Object.hasOwn(fields, "attempt"), expected !== undefined);
  });

test("phase is the current child phase only", async () => {
  assert.equal(
    (await fieldsFor(s2Error(), { setup: (w) => w.setRunning(false) })).phase,
    "other",
  );
  const cancelled = await fieldsFor(s2Error(), {
    setup: (w) => w.setCancelled(true),
  });
  assert.equal(cancelled.phase, "execution_active");
  assert.equal(cancelled.worker_cancelled, true);

  const w = worker();
  w.metadata = Promise.withResolvers();
  const run = await w.start();
  const done = run.finish();
  await tick();
  // Executor returned; the completion packet waits on metadata before cleanup.
  const error = s2Error();
  assert.equal(
    assertTrailer(w.fire(error), error).phase,
    "completion_boundary",
  );
  w.metadata.resolve(undefined);
  await done;
  assert.equal(w.packets.length, 1);
});

test("the largest trailer stays within one 1024-byte line", async () => {
  const fields = await fieldsFor(
    s2Error({ status: 599, code: "UND_ERR_CONNECT_TIMEOUT", origin: "server" }),
    { origin: "unhandledRejection", attempt: 1_000_000 },
  );
  assert.equal(fields.code, "UND_ERR_CONNECT_TIMEOUT");
});

test("non-Error values keep the original branch", async () => {
  const w = worker();
  const run = await w.start();
  const [packet] = w.fire("PRIVATE_STRING_CANARY");
  assert.deepEqual(packet.message.payload, {
    error: { name: "Error", message: "PRIVATE_STRING_CANARY" },
    origin: "uncaughtException",
  });
  await run.finish();
});

test("the worker declares its probe slot before the handler and the helper imports nothing", () => {
  assert.equal(workerParts().slotDeclaredBeforeHandler, true);
  const source = readFileSync(HELPER_PATH, "utf8");
  const sf = ts.createSourceFile("helper.js", source, ts.ScriptTarget.Latest);
  assert.equal(sf.statements.filter(ts.isImportDeclaration).length, 0);
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/);
  assert.match(
    readFileSync(WORKER_SOURCE, "utf8"),
    /from "\.\/s2-uncaught-diagnostic\.js";/,
  );
});

const terminalKind = (stack) =>
  readS2UncaughtTerminal({
    type: "INTERNAL_ERROR",
    code: "TASK_RUN_UNCAUGHT_EXCEPTION",
    stackTrace: stack,
  }).kind;
test("the strict reader rejects malformed, repeated, interior and oversized markers", () => {
  const prefix = s2Stack();
  const json = JSON.stringify(baseFields);
  const line = (body) => `${prefix}\n${MARKER} ${body}`;
  assert.equal(parseS2UncaughtTrailer(line(json)).kind, "valid");
  assert.equal(parseS2UncaughtTrailer(prefix).kind, "absent");
  assert.equal(parseS2UncaughtTrailer(undefined).kind, "absent");
  const invalid = [
    line(json.replace("{", '{"version":1,')),
    line(json.replace("}", ',"extra":true}')),
    line(json.replace(',"attempt":1', ',"PRIVATE_KEY":1')),
    line(json.replace('"version":1,', "")),
    line(json.replace('"version":1', '"version":"1"')),
    line(json.replace('"status":502', '"status":600')),
    line(json.replace('"ECONNRESET"', '"PRIVATE_CODE"')),
    line(json.replace('"worker_running":true', '"worker_running":1')),
    line(JSON.stringify(baseFields, null, 1).replaceAll("\n", "")),
    line(`${json} `),
    line(`${json}x`),
    line(json.replace('"sdk"', '"\\u0073dk"')),
    line(`${json} ${MARKER}`),
    `${line(json)}\n${APP_FRAME}`,
    `S2Error: ${MARKER}\n${line(json).slice(prefix.length + 1)}`,
    `${prefix}\n\\[hackerai.s2_uncaught.v1\\]\n${MARKER} ${json}`,
    line(`${json.slice(0, -1)},"pad":"${"x".repeat(1000)}"}`),
    `${prefix}\n${MARKER}${json}`,
    `${MARKER} ${json}`,
    `${prefix}\0\n${MARKER} ${json}`,
    `${stackOfBytes(kib16 + 1)}\n${MARKER} ${json}`,
    `${prefix}\n${"x".repeat(1025)}\n${MARKER} ${json}`,
    `${s2Stack({ frames: 50 })}\n${MARKER} ${json}`,
    `${s2Stack({ s2: false })}\n${MARKER} ${json}`,
  ];
  for (const stack of invalid)
    assert.equal(terminalKind(stack), "invalid", stack);
  assert.equal(terminalKind(line(json)), "valid");
  assert.equal(
    readS2UncaughtTerminal({
      type: "INTERNAL_ERROR",
      code: "TASK_EXECUTION_FAILED",
      stackTrace: line(json),
    }).kind,
    "absent",
  );
});

// Actual TaskRunProcess fork: real IPC, ZodIpc parsing, attempt rejection and
// SIGTERM, with errors constructed inside @s2-dev/streamstore in the child.
const ipcCases = [
  [
    "active_uncaught",
    "agent-long",
    {
      origin: "uncaughtException",
      message: "Connection failed: ECONNRESET",
      fields: baseFields,
    },
  ],
  [
    "rejection_max_attempts",
    "agent-long",
    {
      origin: "unhandledRejection",
      message: "Max attempts (3) exhausted: synthetic fixture",
      fields: {
        ...baseFields,
        node_origin: "unhandledRejection",
        status: 0,
        code: "other_or_absent",
        max_attempt_exhausted: true,
      },
    },
  ],
  [
    "completion_boundary",
    "agent-long",
    {
      origin: "uncaughtException",
      message: "Connection failed: ECONNRESET",
      fields: { ...baseFields, phase: "completion_boundary" },
    },
  ],
  [
    "non_s2",
    "agent-long",
    { origin: "uncaughtException", message: "PRIVATE_NON_S2_CANARY" },
  ],
  [
    "active_uncaught",
    "health-probe",
    { origin: "uncaughtException", message: "Connection failed: ECONNRESET" },
  ],
];
for (const [scenario, taskId, expected] of ipcCases)
  test(
    `actual TaskRunProcess fork: ${scenario} in ${taskId}`,
    { timeout: 60_000 },
    async () => {
      const result = await runIpcCase({ scenario, taskId });
      assert.equal(result.completion, undefined);
      assert.equal(result.uncaught, true);
      assert.equal(result.origin, expected.origin);
      assert.equal(result.exit.signal, "SIGTERM");
      assert.equal(result.terminal.code, "TASK_RUN_UNCAUGHT_EXCEPTION");
      assert.equal(result.terminal.message, expected.message);
      const read = readS2UncaughtTerminal(result.terminal);
      if (!expected.fields) {
        assert.equal(read.kind, "absent");
        return;
      }
      assert.equal(read.kind, "valid", read.reason);
      assert.deepEqual(read.fields, expected.fields);
      assert.ok(read.prefix.startsWith(`S2Error: ${expected.message}\n`));
      assert.match(read.prefix.split("\n")[1], /^\s+at .*@s2-dev\/streamstore/);
      assert.doesNotMatch(result.terminal.stackTrace, /PRIVATE/);
    },
  );

test(
  "actual TaskRunProcess fork: a successful Agent attempt still completes",
  { timeout: 60_000 },
  async () => {
    const result = await runIpcCase({ scenario: "success" });
    assert.equal(result.uncaught, false);
    assert.equal(result.terminal, undefined);
    assert.equal(result.completion.ok, true);
    assert.equal(result.completion.id, "run_s2_fixture");
  },
);
