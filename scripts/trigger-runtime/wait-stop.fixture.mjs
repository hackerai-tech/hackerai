import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Child process for wait-stop.test.mjs: `node <fixture> esm|cjs`. Loads the
// installed @trigger.dev/sdk in one module format and runs the app's actual
// wait_for_user tool and stop helper through the public wait.createToken and
// wait.forToken against the actual SharedRuntimeManager, usage and lifecycle
// managers and task context. Synthetic boundaries only: globalThis.fetch is a
// deterministic first-writer token engine (no network), the worker IPC is an
// in-memory recorder, and the Convex slot and PostHog logger are stubs. The
// harness inspects SDK internals only to observe state and to deliver the
// worker's RESOLVE_WAITPOINT notification. Prints one bounded JSON line of
// outcomes, booleans and counts, never error text or callback URLs.

const FORMAT = process.argv[2];
const condition = { esm: "import", cjs: "require" }[FORMAT];
if (!condition) throw new Error("Usage: wait-stop.fixture.mjs esm|cjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFrom = (dir) => createRequire(join(dir, "package.json"));
const packageDir = (require, name) =>
  dirname(realpathSync(require.resolve(`${name}/package.json`)));
const SDK = packageDir(requireFrom(ROOT), "@trigger.dev/sdk");
const CORE = packageDir(requireFrom(SDK), "@trigger.dev/core");
/** The file a package export resolves to under this child's condition. */
function entry(dir, subpath = ".") {
  const { exports } = JSON.parse(readFileSync(join(dir, "package.json")));
  return join(dir, exports[subpath][condition].default);
}
const load = (path) =>
  FORMAT === "esm"
    ? import(pathToFileURL(path).href)
    : createRequire(import.meta.url)(path);

for (const protocol of ["node:http", "node:https"]) {
  const forbidden = () => {
    throw new Error("HARNESS_NETWORK_FORBIDDEN");
  };
  Object.assign(createRequire(import.meta.url)(protocol), {
    request: forbidden,
    get: forbidden,
  });
}

// The worker's TracingSDK registers this ALS context manager; with it the
// harness can see whether the callback request ran with tracing suppressed.
const appRequire = requireFrom(ROOT);
const otel = appRequire("@opentelemetry/api");
const { isTracingSuppressed } = appRequire("@opentelemetry/core");
const { AsyncLocalStorageContextManager } = createRequire(
  requireFrom(CORE).resolve("@opentelemetry/sdk-trace-node"),
)("@opentelemetry/context-async-hooks");
otel.context.setGlobalContextManager(
  new AsyncLocalStorageContextManager().enable(),
);

const [sdk, core, workers] = await Promise.all([
  load(entry(SDK)),
  load(entry(CORE, "./v3")),
  load(entry(CORE, "./v3/workers")),
]);
const { apiClientManager, clock, lifecycleHooks, runtime, taskContext } = core;
const {
  DevUsageManager,
  DurableClock,
  ProdUsageManager,
  SharedRuntimeManager,
  StandardLifecycleHooksManager,
  usage,
} = workers;

// Per-case observations; the initial value only absorbs anything before a case.
let current = { ipc: [], attempts: [], unhandled: 0 };
let seq = 0;
process.on("unhandledRejection", () => {
  current.unhandled++;
});

// Worker boot, as managed-run-worker does it, with synthetic identities.
apiClientManager.setGlobalAPIClientConfiguration({
  baseURL: "https://api.trigger.dev",
  accessToken: "fixture-not-a-credential",
});
clock.setGlobalClock(new DurableClock());
const hooks = new StandardLifecycleHooksManager();
lifecycleHooks.setGlobalLifecycleHooksManager(hooks);
const runtimeManager = new SharedRuntimeManager(
  {
    send(type, payload) {
      if (type === "SET_SUSPENDABLE") current.ipc.push(payload.suspendable);
    },
  },
  false,
);
runtime.setGlobalRuntimeManager(runtimeManager);

// Synthetic engine: the published token contract. The first completion
// (callback, reply or timeout) is final; later ones succeed without effect.
// A run learns the winner only through a notification, delivered with the
// same call the worker's RESOLVE_WAITPOINT handler makes.
const ORIGIN = "https://api.trigger.dev";
const MARKER = JSON.stringify({ type: "agent_wait_stopped" });
const tokensByKey = new Map();
const tokensById = new Map();
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
/** Never answers; rejects once the caller's own signal aborts. */
const stalled = (signal, attempt) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener(
      "abort",
      () => {
        attempt.abortedWhileOpen = true;
        reject(new Error("aborted"));
      },
      { once: true },
    ),
  );

function createTokenRecord(key) {
  const id = `waitpoint_fixture${tokensById.size + 1}`;
  const hash = createHash("sha256").update(`synthetic:${id}`).digest("hex");
  const token = { id, hash, status: "WAITING", blocked: false };
  tokensByKey.set(key, token);
  tokensById.set(id, token);
  return token;
}
function commit(token, kind, output, isError = false) {
  if (token.status !== "WAITING") return false;
  Object.assign(token, { status: "COMPLETED", kind, output, isError });
  if (token.blocked && current.notify === "immediate")
    setImmediate(() => deliver(token));
  return true;
}
function deliver(token) {
  if (token.status === "WAITING" || token.delivered) return;
  token.delivered = true;
  runtimeManager
    .resolveWaitpoints([
      {
        id: token.id,
        friendlyId: token.id,
        type: "MANUAL",
        completedAt: new Date(),
        outputIsError: token.isError,
        output: token.output,
        outputType: "application/json",
      },
    ])
    .catch(() => {
      current.deliveryFailed = true;
    });
}
const engine = {
  reply: (token, reply) => commit(token, "reply", JSON.stringify(reply)),
  timeout: (token) =>
    commit(token, "timeout", JSON.stringify({ message: "Timed out" }), true),
  deliver,
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== ORIGIN) throw new Error("HARNESS_NETWORK_FORBIDDEN");
  const path = url.pathname.split("/");
  if (url.pathname === "/api/v1/waitpoints/tokens" && init.method === "POST") {
    const { idempotencyKey } = JSON.parse(init.body);
    current.createTokenCalls++;
    const cached = tokensByKey.get(idempotencyKey);
    const token = cached ?? createTokenRecord(idempotencyKey);
    current.token = token;
    const origin = current.foreignCallback
      ? "https://callbacks.fixture.invalid"
      : ORIGIN;
    return json(200, {
      id: token.id,
      isCached: Boolean(cached),
      url: `${origin}/api/v1/waitpoints/tokens/${token.id}/callback/${token.hash}`,
    });
  }
  // /engine/v1/runs/{run}/waitpoints/tokens/{id}/wait
  if (path[1] === "engine" && path[8] === "wait") {
    const token = tokensById.get(path[7]);
    token.blocked = true;
    current.onWaitRegister?.();
    if (token.status !== "WAITING" && current.notify === "immediate")
      setImmediate(() => deliver(token));
    return json(200, { success: true });
  }
  // /api/v1/waitpoints/tokens/{id}/callback/{hash}
  if (path[1] === "api" && path[6] === "callback") {
    const token = tokensById.get(path[5]);
    const body = new TextDecoder().decode(init.body);
    const attempt = {
      method: init.method,
      redirect: init.redirect,
      contentType: new Headers(init.headers).get("content-type"),
      bodyIsMarker: body === MARKER,
      bodyBytes: init.body.byteLength,
      suppressed: isTracingSuppressed(otel.context.active()),
      signalIsProduct: init.signal === current.stop.signal,
      signalAbortedAtCall: init.signal.aborted,
      signal: init.signal,
      abortedWhileOpen: false,
      bodyCancelled: false,
    };
    current.attempts.push(attempt);
    if (path[7] !== token.hash) return json(401, {});
    const mode = current.callback ?? "ok";
    if (mode === "error_500") return json(500, {});
    if (mode === "stall_headers") return stalled(init.signal, attempt);
    commit(token, "marker", body);
    if (mode === "commit_then_stall") return stalled(init.signal, attempt);
    if (mode === "stall_body")
      return new Response(
        new ReadableStream({
          cancel() {
            attempt.bodyCancelled = true;
          },
        }),
        { status: 200 },
      );
    attempt.responded = true;
    return json(200, { success: true });
  }
  throw new Error("HARNESS_NETWORK_FORBIDDEN");
};

// The public SDK the tool imports. Only forToken is observed: the harness
// records when the tool's original promise settles and returns that promise.
const observedSdk = {
  wait: {
    createToken: (...args) => sdk.wait.createToken(...args),
    forToken(token) {
      const waiting = sdk.wait.forToken(token);
      current.forTokenCalls++;
      const observe = () => (current.originalSettled = ++seq);
      waiting.then(observe, observe);
      return waiting;
    },
  },
};
// Boundary stubs: the Convex reply slot (same compare-and-set outcomes as
// setActiveAgentUserWait) and the PostHog logger.
const slot = { active: undefined };
const stubs = {
  "@trigger.dev/sdk": observedSdk,
  "@/lib/db/agent-user-wait": {
    async setActiveAgentUserWait(args) {
      if (args.tokenId) {
        await current.onAcquire?.();
        if (slot.active)
          return slot.active.toolCallId === args.toolCallId &&
            slot.active.tokenId === args.tokenId
            ? "acquired"
            : "busy";
        slot.active = { toolCallId: args.toolCallId, tokenId: args.tokenId };
        return "acquired";
      }
      if (slot.active?.toolCallId !== args.toolCallId) return "stale";
      slot.active = undefined;
      return "released";
    },
  },
  "@/lib/posthog/server": {
    phLogger: {
      event(name) {
        current.events.push(name);
      },
    },
  },
};

/** The app's actual TypeScript modules, type-stripped, with boundary stubs. */
function loadApp(file) {
  const cache = new Map();
  const loadTs = (path) => {
    if (cache.has(path)) return cache.get(path).exports;
    const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    });
    const module = { exports: {} };
    cache.set(path, module);
    const nodeRequire = createRequire(path);
    const require = (specifier) => {
      if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
      if (specifier.startsWith("@/"))
        return loadTs(join(ROOT, `${specifier.slice(2)}.ts`));
      if (specifier.startsWith("."))
        return loadTs(resolve(dirname(path), `${specifier}.ts`));
      return nodeRequire(specifier);
    };
    vm.compileFunction(outputText, ["exports", "require", "module"], {
      filename: path,
    })(module.exports, require, module);
    return module.exports;
  };
  return loadTs(file);
}
const { createWaitForUserTool } = loadApp(
  join(ROOT, "lib/ai/tools/wait-for-user.ts"),
);

async function turns(count = 10) {
  for (let turn = 0; turn < count; turn++) await new Promise(setImmediate);
}
/** Await a harness-visible state without wall-clock sleeps. */
async function until(condition, label) {
  for (let turn = 0; turn < 500 && !condition(); turn++)
    await new Promise(setImmediate);
  if (!condition()) throw new Error(`HARNESS_NOT_REACHED:${label}`);
}
const untilWaiting = () =>
  until(
    () => runtimeManager.status.resolversById.includes(current.token?.id),
    "waiting",
  );
const untilSettled = () =>
  until(() => current.toolSettled !== undefined, "settled");

/** Reset between executions like the worker, then boot the next run. */
function bootRun(index) {
  usage.reset();
  hooks.reset();
  runtimeManager.reset();
  taskContext.disable();
  const runId = `run_fixture${index}`;
  taskContext.setGlobalTaskContext({
    ctx: {
      run: { id: runId, isTest: true, isReplay: false, tags: [] },
      task: { id: "agent-long", filePath: "trigger/agent-long.ts" },
      attempt: { number: 1, id: `attempt_fixture${index}` },
      queue: { id: "queue_fixture", name: "fixture" },
      environment: { id: "env_fixture", type: "DEVELOPMENT" },
      organization: { id: "org_fixture", slug: "fixture", name: "fixture" },
      project: { id: "proj_fixture", ref: "proj_fixture", name: "fixture" },
      machine: { name: "small-1x", cpu: 1, memory: 1, centsPerMs: 0 },
    },
    worker: { id: "worker_fixture", version: "fixture-only" },
    isWarmStart: index > 0,
  });
  const dev = new DevUsageManager();
  usage.setGlobalUsageManager(new ProdUsageManager(dev, {}));
  usage.start();
  hooks.registerOnWaitHookListener(() => current.waitHooks++);
  hooks.registerOnResumeHookListener(() => current.resumeHooks++);
  return { runId, dev };
}

const CHAT = { chatId: "chat_fixture", userID: "user_fixture" };
const stopNow = () => current.stop.abort(current.reason);

/**
 * Each case: engine/stub configuration plus a script driving the run. Cases
 * run in this order in one process, so every later case also proves the SDK
 * released its single-wait guard after the earlier one.
 */
const cases = [
  [
    "normal_reply",
    {},
    async () => {
      await untilWaiting();
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  [
    "timeout",
    {},
    async () => {
      await untilWaiting();
      engine.timeout(current.token);
      await untilSettled();
    },
  ],
  [
    "stop_before_start",
    {},
    async () => {
      // The script runs after execute() was called with an aborted signal.
      await untilSettled();
    },
    { stopFirst: true },
  ],
  ["stop_during_acquire", { onAcquire: async () => stopNow() }, untilSettled],
  [
    "stop_during_prepare",
    { beforeSuspend: async () => stopNow() },
    untilSettled,
  ],
  [
    "stop_cancel_wins",
    {},
    async () => {
      await untilWaiting();
      stopNow();
      await untilSettled();
    },
  ],
  ["stop_during_registration", { onWaitRegister: stopNow }, untilSettled],
  [
    "stop_reply_wins",
    { notify: "manual" },
    async () => {
      await untilWaiting();
      engine.reply(current.token, current.reply);
      stopNow();
      await turns();
      engine.deliver(current.token);
      await untilSettled();
    },
  ],
  [
    "stop_timeout_wins",
    { notify: "manual" },
    async () => {
      await untilWaiting();
      engine.timeout(current.token);
      stopNow();
      await turns();
      engine.deliver(current.token);
      await untilSettled();
    },
  ],
  [
    "stop_cached_completed",
    { onWaitRegister: stopNow },
    untilSettled,
    { precompleted: true },
  ],
  [
    "delayed_notification",
    { notify: "manual" },
    async () => {
      await untilWaiting();
      stopNow();
      await until(() => current.attempts[0]?.responded, "callback response");
      await turns(50);
      current.pendingAfterHttpSuccess =
        current.toolSettled === undefined &&
        current.originalSettled === undefined;
      engine.deliver(current.token);
      await untilSettled();
    },
  ],
  [
    "repeated_stop",
    {},
    async () => {
      await untilWaiting();
      stopNow();
      current.stop.abort(new Error("later"));
      current.stop.signal.dispatchEvent(new Event("abort"));
      await untilSettled();
    },
  ],
  [
    "callback_rejected",
    { callback: "error_500" },
    async () => {
      await untilWaiting();
      stopNow();
      await turns(50);
      current.pendingAfterRejection = current.toolSettled === undefined;
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  [
    "stalled_headers_reply_settles",
    { callback: "stall_headers" },
    async () => {
      await untilWaiting();
      stopNow();
      await turns();
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  [
    "response_body_discarded",
    { callback: "stall_body" },
    async () => {
      await untilWaiting();
      stopNow();
      await untilSettled();
    },
  ],
  // Committed, but the response never arrives: the request's own deadline
  // aborts it with an unknown result and no retry; the original wait decides.
  [
    "unknown_completion_deadline",
    { callback: "commit_then_stall", notify: "manual" },
    async () => {
      await untilWaiting();
      stopNow();
      await until(() => current.attempts.length === 1, "callback sent");
      await new Promise((resolve) =>
        current.attempts[0].signal.addEventListener("abort", resolve, {
          once: true,
        }),
      );
      await turns(50);
      current.pendingAfterDeadline = current.toolSettled === undefined;
      engine.deliver(current.token);
      await untilSettled();
    },
  ],
  [
    "foreign_callback",
    { foreignCallback: true },
    async () => {
      await untilWaiting();
      stopNow();
      await turns(50);
      current.pendingWithoutCallback = current.toolSettled === undefined;
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  // The reply already woke the original wait; a stop while revalidating it
  // must throw the first reason with no resumed event or callback.
  [
    "stop_during_revalidation",
    { onRevalidate: async () => stopNow() },
    async () => {
      await untilWaiting();
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  ["stop_during_pause", { onPause: stopNow }, untilSettled],
  [
    "next_warm_reply",
    {},
    async () => {
      await untilWaiting();
      engine.reply(current.token, current.reply);
      await untilSettled();
    },
  ],
  // Last: without a notification the original wait stays pending by
  // contract, holding the SDK wait guard. A limitation, not a bounded stop.
  [
    "never_notified",
    { notify: "manual" },
    async () => {
      await untilWaiting();
      stopNow();
      await until(() => current.attempts[0]?.responded, "callback response");
      await turns(200);
    },
  ],
];

async function runCase(index, [name, config, script, options = {}]) {
  const { runId, dev } = bootRun(index);
  const toolCallId = `tool_fixture${index}`;
  const reason = new Error(`synthetic stop ${name}`);
  current = {
    notify: "immediate",
    ...config,
    reason,
    stop: new AbortController(),
    reply: {
      ...CHAT,
      userId: CHAT.userID,
      runId,
      toolCallId,
      replyId: `reply_${index}`,
      text: "Synthetic answer",
    },
    ipc: [],
    attempts: [],
    events: [],
    abortRun: [],
    unhandled: 0,
    createTokenCalls: 0,
    forTokenCalls: 0,
    waitHooks: 0,
    resumeHooks: 0,
    revalidations: 0,
    pauseActive: 0,
    resumeActive: 0,
  };
  if (options.precompleted) {
    const token = createTokenRecord(`agent-user-wait:${runId}:${toolCallId}`);
    commit(token, "reply", JSON.stringify(current.reply));
  }
  if (options.stopFirst) stopNow();
  const tool = createWaitForUserTool(
    { ...CHAT, triggerRunId: runId },
    {
      signal: current.stop.signal,
      beforeSuspend: current.beforeSuspend,
      pauseActiveTime: () => {
        current.pauseActive++;
        current.onPause?.();
      },
      resumeActiveTime: () => current.resumeActive++,
      // As in agent-long: the tool's own outcome aborts the same stop signal.
      abortRun: (outcome) => {
        current.abortRun.push(outcome);
        current.stop.abort(
          outcome === "timed_out" ? "wait_for_user_timeout" : "wait_for_user",
        );
      },
      revalidateAfterSuspend: async () => {
        current.revalidations++;
        await current.onRevalidate?.();
      },
    },
  );
  tool.execute({}, { toolCallId, messages: [] }).then(
    (result) => {
      current.result = result;
      current.toolSettled = ++seq;
    },
    (error) => {
      current.error = error;
      current.toolSettled = ++seq;
    },
  );
  try {
    await script();
  } catch (error) {
    current.harnessError = String(error.message).slice(0, 80);
  }
  await turns();
  const attempt = current.attempts[0];
  return {
    name,
    harnessError: current.harnessError ?? null,
    outcome:
      current.toolSettled === undefined
        ? "pending"
        : current.error === undefined
          ? "returned"
          : current.error === reason
            ? "first_stop"
            : "rejected_other",
    waitOutcome: current.result?.wait_outcome ?? null,
    success: current.result?.success ?? null,
    originalSettledBeforeTool:
      current.originalSettled !== undefined &&
      current.toolSettled !== undefined &&
      current.originalSettled < current.toolSettled,
    originalPending:
      current.forTokenCalls > 0 && current.originalSettled === undefined,
    createTokenCalls: current.createTokenCalls,
    forTokenCalls: current.forTokenCalls,
    suspendable: current.ipc,
    waitHooks: current.waitHooks,
    resumeHooks: current.resumeHooks,
    usagePausesOpen: [...dev._pauses.values()].filter((p) => !p.end).length,
    pauseActive: current.pauseActive,
    resumeActive: current.resumeActive,
    abortRun: current.abortRun,
    revalidations: current.revalidations,
    startedEvents: current.events.filter((e) => e.endsWith("_started")).length,
    resumedEvents: current.events.filter((e) => e.endsWith("_resumed")).length,
    slotHeld: slot.active?.toolCallId === toolCallId,
    tokenResult: current.token?.kind ?? (current.token ? "waiting" : null),
    callbackAttempts: current.attempts.length,
    callback: attempt
      ? {
          method: attempt.method,
          redirect: attempt.redirect,
          contentType: attempt.contentType,
          bodyIsMarker: attempt.bodyIsMarker,
          bodyBytes: attempt.bodyBytes,
          suppressed: attempt.suppressed,
          signalIsProduct: attempt.signalIsProduct,
          signalAbortedAtCall: attempt.signalAbortedAtCall,
          abortedWhileOpen: attempt.abortedWhileOpen,
          bodyCancelled: attempt.bodyCancelled,
        }
      : null,
    pendingAfterHttpSuccess: current.pendingAfterHttpSuccess ?? null,
    pendingAfterRejection: current.pendingAfterRejection ?? null,
    pendingAfterDeadline: current.pendingAfterDeadline ?? null,
    pendingWithoutCallback: current.pendingWithoutCallback ?? null,
    deliveryFailed: current.deliveryFailed ?? false,
    unhandled: current.unhandled,
  };
}

const results = [];
for (const [index, spec] of cases.entries())
  results.push(await runCase(index, spec));
// SharedRuntimeManager keeps a status interval and the last case's original
// wait is deliberately still pending, so exit once the report is written.
process.stdout.write(
  `${JSON.stringify({ format: FORMAT, markerBytes: Buffer.byteLength(MARKER), results })}\n`,
  () => process.exit(0),
);
