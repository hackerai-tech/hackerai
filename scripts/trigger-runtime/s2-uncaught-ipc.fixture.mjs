import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Reusable S2 uncaught carrier fixture. It evaluates the managed worker's actual
// safeSend, uncaughtException handler, reset and EXECUTE_TASK_RUN handler in one
// module-like scope; only SDK managers, bootstrap and the task body are
// controlled. Imported, it builds in-process workers and drives the actual CLI
// TaskRunProcess against itself. Forked by TaskRunProcess with
// S2_UNCAUGHT_FIXTURE_ROLE=child, it is that worker: a real ZodIpc listener,
// real process.on/process.send and errors constructed inside
// @s2-dev/streamstore. S2_UNCAUGHT_WORKER_SOURCE may name an older worker file
// for baseline proof. Synthetic values only; nothing leaves the host.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE = fileURLToPath(import.meta.url);
const CLI = realpathSync(join(ROOT, "node_modules/trigger.dev"));
const requireFromCli = createRequire(join(CLI, "package.json"));
const CORE = dirname(requireFromCli.resolve("@trigger.dev/core/package.json"));
const S2 = resolve(
  dirname(
    createRequire(join(CORE, "package.json")).resolve("@s2-dev/streamstore"),
  ),
  "../..",
);
const ENTRY = join(CLI, "dist/esm/entryPoints");
const load = (path) => import(pathToFileURL(path).href);
const core = (rel) => load(join(CORE, "dist/esm/v3", rel));
const [{ ZodIpcConnection }, messages, common, errors, contextApi] =
  await Promise.all([
    core("zodIpc.js"),
    core("schemas/messages.js"),
    core("schemas/common.js"),
    core("errors.js"),
    core("task-context-api.js"),
  ]);
export const { taskContext } = contextApi;
export const WORKER_SOURCE =
  process.env.S2_UNCAUGHT_WORKER_SOURCE || join(ENTRY, "managed-run-worker.js");
export const HELPER_PATH = join(ENTRY, "s2-uncaught-diagnostic.js");
const helper = existsSync(HELPER_PATH) ? await load(HELPER_PATH) : undefined;
const { createChildCompletionProbe } = await load(
  join(ENTRY, "child-completion-probe.js"),
);
// A baseline worker never calls the helper; a missing one fails loudly if used.
const missingHelper = () => {
  throw new Error("S2 uncaught helper is not installed");
};
const taskRunProcess = () =>
  load(join(CLI, "dist/esm/executions/taskRunProcess.js"));

/** Extract each worker boundary once so a missing or duplicated one fails loudly. */
export function workerParts(source = readFileSync(WORKER_SOURCE, "utf8")) {
  const sf = ts.createSourceFile(
    "worker.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = new Map();
  const add = (key, node) => found.set(key, [...(found.get(key) ?? []), node]);
  (function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      ["safeSend", "resetExecutionEnvironment"].includes(node.name?.text)
    )
      add(node.name.text, node);
    else if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(sf) === "process.on" &&
      node.expression.arguments[0]?.getText(sf) === '"uncaughtException"'
    )
      add("uncaught", node);
    else if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sf) === "EXECUTE_TASK_RUN"
    )
      add("execute", node.initializer);
    else if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === "_s2UncaughtProbe"
    )
      add("slot", node);
    ts.forEachChild(node, visit);
  })(sf);
  const one = (key) => {
    const nodes = found.get(key) ?? [];
    assert.equal(nodes.length, 1, `exactly one worker ${key}`);
    return nodes[0];
  };
  return {
    safeSend: one("safeSend").getText(sf),
    reset: one("resetExecutionEnvironment").getText(sf),
    uncaught: one("uncaught").getText(sf),
    execute: one("execute").getText(sf),
    // The handler reads the slot; a later `let` would throw in its temporal dead zone.
    slotDeclaredBeforeHandler: found.has("slot")
      ? one("slot").getStart(sf) < one("uncaught").getStart(sf)
      : undefined,
  };
}

const parts = workerParts();
const instantiate = new Function(
  "h",
  `
 const { process, console, populateEnv, standardInputStreamManager, standardTraceContextManager, initializeUsageManager, getEnvVar, getNumberEnvVar, standardRunTimelineMetricsManager, TaskRunContext, taskContext, bootstrap, resourceCatalog, runMetadataManager, TaskExecutor, TaskRunErrorCodes, standardHeartbeatsManager, usage, timeout, NO_FILE_CONTEXT, standardLocalsManager, standardLifecycleHooksManager, waitUntilManager, standardRealtimeStreamsManager, standardSessionStreamManager, durableClock, resetIdempotencyKeyCatalog, waitUntil, createChildCompletionProbe, createS2UncaughtProbe, annotateS2Uncaught } = h;
 let _execution, _isRunning = false, _isCancelled = false, _tracingSDK, _executionMeasurement, _cancelController = new AbortController(), _lastFlushPromise, _sharedWorkerRuntime, _parentFlushReceipt, _s2UncaughtProbe, _lastEnv, _executionCount = 0;
 ${parts.safeSend}
 ${parts.reset}
 ${parts.uncaught}
 const EXECUTE_TASK_RUN = ${parts.execute};
 return {
  EXECUTE_TASK_RUN,
  reset: resetExecutionEnvironment,
  current: () => _execution,
  setExecution: (v) => { _execution = v; },
  setRunning: (v) => { _isRunning = v; },
  setCancelled: (v) => { _isCancelled = v; },
  setLastFlush: (p) => { _lastFlushPromise = p; },
 };
`,
);

export const serverWorker = {
  id: "worker_fixture",
  version: "fixture",
  contentHash: "fixture",
};
const okResult = (execution) => ({
  result: {
    ok: true,
    id: execution.run.id,
    output: '{"fixture":true}',
    outputType: "application/json",
  },
});
const noopTracer = { startSpan: () => ({ setAttribute() {}, end() {} }) };

/**
 * Build one worker scope. `run(execution)` is the task body and `metadata()` the
 * completion packet's flushed metadata. Without `process`, a recording fake is
 * used and `fire(error, origin)` invokes the registered handler directly.
 * `events` records console.error and send order; nothing is printed.
 */
export function createWorker({
  process: given,
  run = async (execution) => okResult(execution),
  metadata = () => undefined,
} = {}) {
  const events = [];
  const proc = given ?? {
    connected: true,
    listeners: [],
    sent: [],
    on(event, fn) {
      if (event === "uncaughtException") this.listeners.push(fn);
    },
    send(message) {
      events.push({ kind: "send" });
      this.sent.push(message);
    },
  };
  const reset = { reset() {} };
  const scope = instantiate({
    process: proc,
    console: {
      log() {},
      error(label, detail) {
        events.push({ kind: "console.error", label, detail });
      },
    },
    populateEnv() {},
    standardInputStreamManager: { reset() {}, setRunId() {} },
    standardTraceContextManager: { reset() {}, extractContext: () => ({}) },
    initializeUsageManager: () => ({ setInitialState() {} }),
    getEnvVar: () => undefined,
    getNumberEnvVar: (_name, fallback) => fallback,
    standardRunTimelineMetricsManager: {
      reset() {},
      registerMetricsFromExecution() {},
    },
    TaskRunContext: { parse: () => ({}) },
    taskContext,
    bootstrap: async () => ({
      tracer: noopTracer,
      tracingSDK: { flush() {} },
      consoleInterceptor: {},
      config: {},
      workerManifest: { tasks: [{ id: "agent-long" }, { id: "health-probe" }] },
    }),
    resourceCatalog: {
      getTask: () => ({}),
      setCurrentFileContext() {},
      clearCurrentFileContext() {},
    },
    runMetadataManager: {
      reset() {},
      startPeriodicFlush() {},
      stopAndReturnLastFlush: () => metadata(),
    },
    TaskExecutor: class {
      execute(execution) {
        return run(execution);
      }
    },
    TaskRunErrorCodes: common.TaskRunErrorCodes,
    standardHeartbeatsManager: {
      reset() {},
      startHeartbeat() {},
      stopHeartbeat() {},
    },
    usage: { reset() {}, start: () => ({}), stop: () => ({ cpuTime: 1 }) },
    timeout: { reset() {}, abortAfterTimeout: () => new AbortController() },
    NO_FILE_CONTEXT: "fixture",
    standardLocalsManager: reset,
    standardLifecycleHooksManager: reset,
    waitUntilManager: reset,
    standardRealtimeStreamsManager: reset,
    standardSessionStreamManager: reset,
    durableClock: reset,
    resetIdempotencyKeyCatalog() {},
    waitUntil: { register() {} },
    createChildCompletionProbe,
    createS2UncaughtProbe: helper?.createS2UncaughtProbe ?? missingHelper,
    annotateS2Uncaught: helper?.annotateS2Uncaught ?? missingHelper,
  });
  return {
    ...scope,
    events,
    process: proc,
    fire(error, origin = "uncaughtException") {
      const before = proc.sent.length;
      for (const listener of proc.listeners) listener(error, origin);
      return proc.sent.slice(before);
    },
  };
}

/** A schema-valid synthetic TaskRunExecution with no customer data. */
export function syntheticExecution({
  taskId = "agent-long",
  attempt = 1,
  runId = "run_s2_fixture",
} = {}) {
  return {
    task: { id: taskId, filePath: "trigger/fixture.ts" },
    attempt: { number: attempt, startedAt: new Date(0) },
    run: {
      id: runId,
      payload: "{}",
      payloadType: "application/json",
      tags: [],
      isTest: true,
      createdAt: new Date(0),
      maxDuration: 60,
    },
    queue: { id: "queue_fixture", name: "fixture" },
    environment: { id: "env_fixture", slug: "fixture", type: "DEVELOPMENT" },
    organization: { id: "org_fixture", slug: "fixture", name: "fixture" },
    project: {
      id: "proj_fixture",
      ref: "proj_fixture",
      slug: "fixture",
      name: "fixture",
    },
    machine: { name: "small-1x", cpu: 0.5, memory: 1, centsPerMs: 0 },
  };
}

/** Map a parent-side rejection through the actual CLI and core terminal serializers. */
export async function parentTerminal(error) {
  const { TaskRunProcess } = await taskRunProcess();
  return common.TaskRunInternalError.parse(
    errors.sanitizeError(TaskRunProcess.parseExecuteError(error)),
  );
}

/** Parse an in-process UNCAUGHT_EXCEPTION packet exactly as the parent's ZodIpc does. */
export async function parentTerminalFromPacket(packet) {
  assert.equal(packet.type, "EVENT");
  assert.equal(packet.message.type, "UNCAUGHT_EXCEPTION");
  const parsed =
    messages.ExecutorToWorkerMessageCatalog.UNCAUGHT_EXCEPTION.message.parse(
      packet.message.payload,
    );
  return parentTerminal(
    new errors.UncaughtExceptionError(parsed.error, parsed.origin),
  );
}

// Reader contract, written independently of the worker helper.
export const MARKER = "[hackerai.s2_uncaught.v1]";
const TOKEN = "hackerai.s2_uncaught";
export const CODES = [
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "NETWORK_ERROR",
  "connection_failed",
  "REQUEST_TIMEOUT",
  "TIMEOUT",
  "CONNECTION_TIMEOUT",
  "STREAM_CLOSED_PREMATURELY",
  "BAD_GATEWAY",
  "SESSION_CLOSED",
  "INVALID_RESPONSE",
  "INVALID_ARGUMENT",
  "UNSAFE_INTEGER",
  "APPEND_CONDITION_FAILED",
  "INTERNAL_ERROR",
  "INTERNAL_SDK_ERROR",
  "ABORTED",
  "rate_limited",
  "hot_server",
];
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);
const bool = (v) => typeof v === "boolean";
// [key, valid, optional] in the canonical serialized order.
const SCHEMA = [
  ["version", (v) => v === 1],
  ["association", oneOf("current_child_context")],
  ["phase", oneOf("execution_active", "completion_boundary", "other")],
  [
    "node_origin",
    oneOf("uncaughtException", "unhandledRejection", "other_or_absent"),
  ],
  [
    "status",
    (v) => Number.isInteger(v) && (v === 0 || (v >= 100 && v <= 599)),
    true,
  ],
  ["code", oneOf(...CODES, "other_or_absent")],
  ["property_origin", oneOf("server", "sdk", "other_or_absent")],
  ["max_attempt_exhausted", bool],
  ["worker_running", bool],
  ["worker_cancelled", bool],
  ["process_connected", bool],
  ["attempt", (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000, true],
];

/**
 * Strictly read a trailer: absent without the marker token; invalid unless one
 * marker anchors the last line and its JSON is exactly the canonical closed
 * schema (rejecting repeats, interior/message/escaped occurrences, duplicate or
 * unknown keys, whitespace, trailing data and lines over 1024 bytes).
 */
export function parseS2UncaughtTrailer(stack) {
  if (typeof stack !== "string" || !stack.includes(TOKEN))
    return { kind: "absent" };
  const invalid = (reason) => ({ kind: "invalid", reason });
  const newline = stack.lastIndexOf("\n");
  const line = stack.slice(newline + 1);
  if (newline < 0 || !line.startsWith(`${MARKER} `))
    return invalid("not anchored to the last line");
  if (
    stack.indexOf(TOKEN) !== newline + 2 ||
    stack.indexOf(TOKEN, newline + 2 + TOKEN.length) !== -1
  )
    return invalid("repeated or interior marker");
  if (Buffer.byteLength(`\n${line}`, "utf8") > 1024)
    return invalid("oversized trailer");
  const prefix = stack.slice(0, newline);
  if (prefix.includes("\0") || Buffer.byteLength(prefix, "utf8") > 16 * 1024)
    return invalid("original stack outside writer bounds");
  let frameLines = 0;
  let s2Frame = false;
  for (const originalLine of prefix.split("\n")) {
    if (originalLine.length > 1024) return invalid("oversized original line");
    const frame = originalLine.trimStart().startsWith("at ");
    if (frame || frameLines > 0) frameLines++;
    if (frame && originalLine.includes("@s2-dev/streamstore")) s2Frame = true;
  }
  if (!s2Frame || frameLines >= 50)
    return invalid("original frames outside writer bounds");
  const json = line.slice(MARKER.length + 1);
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return invalid("malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("not an object");
  for (const key of Object.keys(value))
    if (!SCHEMA.some(([known]) => known === key)) return invalid("unknown key");
  for (const [key, valid, optional] of SCHEMA) {
    if (!Object.hasOwn(value, key)) {
      if (!optional) return invalid("missing key");
    } else if (!valid(value[key])) return invalid("invalid value");
  }
  const canonical = Object.fromEntries(
    SCHEMA.filter(([key]) => Object.hasOwn(value, key)).map(([key]) => [
      key,
      value[key],
    ]),
  );
  if (JSON.stringify(canonical) !== json) return invalid("non-canonical JSON");
  return { kind: "valid", prefix, fields: value };
}

/** Read only the exact public uncaught terminal error; any other shape is absent. */
export function readS2UncaughtTerminal(terminal) {
  if (
    terminal?.type !== "INTERNAL_ERROR" ||
    terminal.code !== "TASK_RUN_UNCAUGHT_EXCEPTION"
  )
    return { kind: "absent" };
  return parseS2UncaughtTrailer(terminal.stackTrace);
}

/**
 * Fork this fixture as the managed worker through the actual CLI TaskRunProcess,
 * execute one synthetic attempt and return the parent's terminal view. Usable
 * unchanged in an isolated Linux container. The child is SIGKILLed after
 * `timeoutMs` if it never settles.
 */
export async function runIpcCase({
  scenario,
  taskId = "agent-long",
  workerSource = WORKER_SOURCE,
  timeoutMs = 20_000,
}) {
  const { TaskRunProcess } = await taskRunProcess();
  const child = new TaskRunProcess({
    workerManifest: { workerEntryPoint: FIXTURE, runtime: "node" },
    env: {
      S2_UNCAUGHT_FIXTURE_ROLE: "child",
      S2_UNCAUGHT_SCENARIO: scenario,
      S2_UNCAUGHT_WORKER_SOURCE: workerSource,
    },
    cwd: ROOT,
    machineResources: { cpu: 0.5, memory: 1 },
    serverWorker,
    gracefulTerminationTimeoutInMs: 5_000,
    isWarmStart: false,
  });
  // Messages sent before the child's listener exists can be dropped, so wait
  // for its existing SEND_DEBUG_LOG readiness event before EXECUTE.
  const ready = new Promise((r) => child.onSendDebugLog.attachOnce(r));
  const exited = new Promise((r) => child.onExit.attachOnce(r));
  child.initialize();
  const guard = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  let completion, rejection;
  try {
    await Promise.race([
      ready,
      exited.then(() => {
        throw new Error("fixture worker exited before it was ready");
      }),
    ]);
    completion = await child.execute({
      payload: {
        execution: syntheticExecution({ taskId }),
        traceContext: {},
        metrics: [],
      },
      env: {},
    });
  } catch (error) {
    rejection = error;
  }
  if (completion) await child.kill("SIGKILL");
  const exit = await exited;
  clearTimeout(guard);
  const uncaught = rejection instanceof errors.UncaughtExceptionError;
  return {
    completion,
    uncaught,
    origin: uncaught ? rejection.origin : undefined,
    terminal: rejection ? await parentTerminal(rejection) : undefined,
    exit: { code: exit.code, signal: exit.signal },
  };
}

export const IPC_CASES = [
  ["active_uncaught", "agent-long"],
  ["rejection_max_attempts", "agent-long"],
  ["completion_boundary", "agent-long"],
  ["non_s2", "agent-long"],
  ["active_uncaught", "health-probe"],
  ["success", "agent-long"],
];

if (process.env.S2_UNCAUGHT_FIXTURE_ROLE === "child") {
  // Same source-map-support install as the worker, so stacks take its format path.
  requireFromCli("source-map-support").install({
    handleUncaughtExceptions: false,
    environment: "node",
    hookRequire: false,
  });
  const { s2Error } = await load(join(S2, "dist/esm/error.js"));
  // Constructed inside @s2-dev/streamstore, so V8 records a real S2 frame.
  const connectionReset = () =>
    s2Error(
      Object.assign(new Error("PRIVATE_S2_CAUSE_CANARY"), {
        code: "ECONNRESET",
      }),
    );
  const maxAttempts = () =>
    s2Error(new Error("Max attempts (3) exhausted: synthetic fixture"));
  const pending = () => new Promise(() => {});
  const scenarios = {
    active_uncaught: {
      run() {
        setImmediate(() => {
          throw connectionReset();
        });
        return pending();
      },
    },
    rejection_max_attempts: {
      run() {
        Promise.reject(maxAttempts());
        return pending();
      },
    },
    completion_boundary: {
      metadata() {
        setImmediate(() => {
          throw connectionReset();
        });
        return pending();
      },
    },
    non_s2: {
      run() {
        setImmediate(() => {
          throw new Error("PRIVATE_NON_S2_CANARY");
        });
        return pending();
      },
    },
    success: {},
  };
  const scenario = scenarios[process.env.S2_UNCAUGHT_SCENARIO];
  assert.ok(scenario, "known S2 uncaught fixture scenario");
  const worker = createWorker({ process, ...scenario });
  const ipc = new ZodIpcConnection({
    listenSchema: messages.WorkerToExecutorMessageCatalog,
    emitSchema: messages.ExecutorToWorkerMessageCatalog,
    process,
    handlers: {
      EXECUTE_TASK_RUN: (payload, sender) =>
        worker.EXECUTE_TASK_RUN(payload, sender),
    },
  });
  await ipc.send("SEND_DEBUG_LOG", { message: "s2 uncaught fixture ready" });
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // Direct run: one bounded receipt per case, with no messages or stacks.
  const receipts = [];
  for (const [scenario, taskId] of IPC_CASES) {
    const result = await runIpcCase({ scenario, taskId });
    const read = readS2UncaughtTerminal(result.terminal);
    receipts.push({
      scenario,
      taskId,
      completed: result.completion?.ok === true,
      code: result.terminal?.code,
      trailer: read.kind,
      fields: read.fields,
      exitSignal: result.exit.signal,
    });
  }
  console.log(
    JSON.stringify({
      workerSource: process.env.S2_UNCAUGHT_WORKER_SOURCE
        ? "override"
        : "installed",
      helperInstalled: helper !== undefined,
      receipts,
    }),
  );
}
