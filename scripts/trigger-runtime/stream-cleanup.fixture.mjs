import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Child process for stream-cleanup.test.mjs: `node <fixture> esm|cjs`. Loads
// the installed @trigger.dev/sdk through its package exports in one module
// format, with the actual core StandardRealtimeStreamsManager, StreamInstance
// and StreamsWriterV2 plus the app's actual waitForAgentUiStream. Only the
// Trigger createStream response, the S2 append session and the OTel span sink
// are synthetic; fetch is forbidden. Prints one bounded JSON line: outcomes,
// identity booleans and counts, never error text.
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls++;
  return Promise.reject(new Error("HARNESS_NETWORK_FORBIDDEN"));
};

const FORMAT = process.argv[2];
const condition = { esm: "import", cjs: "require" }[FORMAT];
if (!condition) throw new Error("Usage: stream-cleanup.fixture.mjs esm|cjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFrom = (dir) => createRequire(join(dir, "package.json"));
const packageDir = (require, name) =>
  dirname(realpathSync(require.resolve(`${name}/package.json`)));
const SDK = packageDir(requireFrom(ROOT), "@trigger.dev/sdk");
const CORE = packageDir(requireFrom(SDK), "@trigger.dev/core");
// @s2-dev/streamstore does not export package.json; walk up from its entry.
const S2_DIR = resolve(
  dirname(realpathSync(requireFrom(CORE).resolve("@s2-dev/streamstore"))),
  "../..",
);
/** The file a package export resolves to under this child's condition. */
function entry(dir, subpath = ".") {
  const { exports } = JSON.parse(readFileSync(join(dir, "package.json")));
  return join(dir, exports[subpath][condition].default);
}
const load = (path) =>
  FORMAT === "esm"
    ? import(pathToFileURL(path).href)
    : createRequire(import.meta.url)(path);

// OTel keeps its tracer provider in a process global, so either build reaches
// the tracer core uses. Spans record only counts.
const { trace, SpanStatusCode } = requireFrom(CORE)("@opentelemetry/api");
// Per-case observations; the initial value only absorbs anything before a case.
let current = { spans: [], unhandled: [] };
trace.setGlobalTracerProvider({
  getTracer: () => ({
    startSpan(name) {
      const record = { name, ends: 0, exceptions: 0, error: false };
      current.spans.push(record);
      return {
        end() {
          record.ends++;
          if (current.spanEndThrows) throw new Error("SYNTHETIC_SPAN_END");
        },
        recordException() {
          record.exceptions++;
        },
        setStatus({ code }) {
          record.error = code === SpanStatusCode.ERROR;
          return this;
        },
        setAttribute() {
          return this;
        },
        setAttributes() {
          return this;
        },
        addEvent() {
          return this;
        },
        updateName() {
          return this;
        },
        isRecording: () => true,
        spanContext: () => ({
          traceId: "1".repeat(32),
          spanId: "1".repeat(16),
          traceFlags: 1,
        }),
      };
    },
  }),
});

const [{ streams }, core, workers, { S2, S2Error }] = await Promise.all([
  load(entry(SDK)),
  load(entry(CORE, "./v3")),
  load(entry(CORE, "./v3/workers")),
  load(entry(S2_DIR)),
]);

// Remote boundary 1: the Trigger API's createStream. A v2 response sends the
// actual StreamInstance down its StreamsWriterV2 path.
const apiClient = {
  createStream() {
    if (current.construct) throw current.construct;
    return Promise.resolve({
      version: "v2",
      headers: {
        "x-s2-access-token": "synthetic",
        "x-s2-basin": "synthetic-basin",
        "x-s2-flush-interval-ms": "1",
      },
    });
  },
  getHeaders: () => ({}),
};
const manager = new workers.StandardRealtimeStreamsManager(
  apiClient,
  "https://stream-cleanup.invalid",
);
core.realtimeStreams.setGlobalManager(manager);
// Remote boundary 2: the S2 append session the writer pipes batches into.
S2.prototype.basin = () => ({
  stream: () => ({
    appendSession: async () => ({
      writable: new WritableStream({
        write(_batch, controller) {
          current.writeStarted.resolve();
          if (current.write) return current.write(controller);
        },
      }),
      lastAckedPosition: () => undefined,
    }),
  }),
});

const HELPER = join(ROOT, "lib/chat/consume-agent-ui-stream.ts");
/** The app's actual helper, type-stripped and resolving `ai` from its own path. */
function loadHelper() {
  const { outputText } = ts.transpileModule(readFileSync(HELPER, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: HELPER,
  });
  const helperModule = { exports: {} };
  vm.compileFunction(outputText, ["exports", "require", "module"], {
    filename: HELPER,
  })(helperModule.exports, createRequire(HELPER), helperModule);
  return helperModule.exports.waitForAgentUiStream;
}
const waitForAgentUiStream = loadHelper();

process.on("unhandledRejection", (reason) => {
  current.unhandled.push(reason);
});
// Settled stream promise chains are microtasks, and Node reports unhandled
// rejections once those drain; each later macrotask turn starts after both.
async function turns() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

const KEY = "agent-ui";
const chunk = { type: "text-delta", id: "t", delta: "synthetic" };
const source = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
/** Reject the append, keeping the error so callers can be checked for identity. */
function fail(error) {
  current.error = error;
  return Promise.reject(error);
}
const failures = {
  success: {},
  s2_hot_server: {
    write: () =>
      fail(
        new S2Error({
          message: "synthetic hot server",
          code: "hot_server",
          status: 502,
          origin: "server",
        }),
      ),
  },
  transport_abort: {
    write: () =>
      fail(new DOMException("synthetic transport abort", "AbortError")),
  },
  // The in-flight append fails once the caller cancels. (pipeTo locks the
  // writable, so the writer's own abort() of it cannot end the write.)
  caller_cancel: {
    write: () =>
      new Promise((_, reject) =>
        current.callerSignal.addEventListener("abort", () =>
          reject(current.callerSignal.reason),
        ),
      ),
  },
};

const define = () => streams.define({ id: KEY });
const execute = ({ write }) => write(chunk);
/** Public entry points, each returning what its caller awaits. */
const entries = {
  "define.pipe": (options) =>
    waitForAgentUiStream(define().pipe(source(), options)),
  "pipe(key)": (options) =>
    waitForAgentUiStream(streams.pipe(KEY, source(), options)),
  "pipe(default key)": (options) =>
    waitForAgentUiStream(streams.pipe(source(), options)),
  writer: (options) =>
    streams.writer(KEY, { ...options, execute }).waitUntilComplete(),
  "define.writer": (options) =>
    define()
      .writer({ ...options, execute })
      .waitUntilComplete(),
  "define.append": (options) => define().append(chunk, options),
};

/**
 * Run one caller and report how its own await settled, whether it saw the
 * exact original error, and what else surfaced. `delayed` lets the remote
 * failure settle before the caller first awaits (immediate otherwise).
 */
async function runCase({
  entry: name = "define.pipe",
  failure = "success",
  delayed = false,
  spanEndThrows = false,
  construct,
}) {
  const signal = new AbortController();
  current = {
    ...failures[failure],
    construct,
    spanEndThrows,
    callerSignal: signal.signal,
    spans: [],
    unhandled: [],
    writeStarted: Promise.withResolvers(),
  };
  if (construct) current.error = construct;
  // No task context here, so name the run; only cancellation passes a signal.
  const options = {
    target: `run_${FORMAT}`,
    ...(failure === "caller_cancel" ? { signal: signal.signal } : {}),
  };
  let pipe;
  let outcome;
  let reason;
  let settledBeforeAwait = null;
  try {
    if (name === "define.pipe" && (delayed || construct)) {
      // Split the app's pipe call from its helper await.
      try {
        pipe = define().pipe(source(), options);
      } catch (error) {
        outcome = "threw";
        throw error;
      }
      if (delayed) {
        // The failing append has returned; once its rejection has propagated,
        // the core manager has retired the stream. Report that, so a delay
        // that did not cover the failure fails instead of passing vacuously.
        await current.writeStarted.promise;
        await turns();
        settledBeforeAwait = !manager.hasActiveStreams();
      }
      await waitForAgentUiStream(pipe);
    } else {
      const done = entries[name](options);
      if (failure === "caller_cancel") {
        await current.writeStarted.promise;
        signal.abort();
      }
      await done;
    }
    outcome = "fulfilled";
  } catch (error) {
    outcome ??= "rejected";
    reason = error;
  }
  await turns();
  return {
    entry: name,
    failure: construct ? `construct_${construct.name}` : failure,
    delayed,
    spanEndThrows,
    outcome,
    settledBeforeAwait,
    originalReason: reason !== undefined && reason === current.error,
    unhandled: current.unhandled.length,
    spans: current.spans.map(({ name, ends, exceptions, error }) => ({
      name,
      ends,
      exceptions,
      error,
    })),
  };
}

const constructError = (name) =>
  Object.assign(new Error("synthetic construction failure"), { name });
const cases = [
  ...Object.keys(failures).map((failure) => ({ failure })),
  { failure: "s2_hot_server", delayed: true },
  { failure: "transport_abort", delayed: true },
  { failure: "success", spanEndThrows: true },
  { failure: "s2_hot_server", spanEndThrows: true },
  { construct: constructError("TypeError") },
  { construct: constructError("AbortError") },
  ...Object.keys(entries)
    .filter((entry) => entry !== "define.pipe")
    .flatMap((entry) => [
      { entry, failure: "success" },
      { entry, failure: "s2_hot_server" },
    ]),
];
const results = [];
for (const c of cases) results.push(await runCase(c));
process.stdout.write(
  `${JSON.stringify({ format: FORMAT, fetchCalls, results })}\n`,
);
