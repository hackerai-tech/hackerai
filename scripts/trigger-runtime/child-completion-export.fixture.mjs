import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
// Each process owns one real SDK provider. Keep all sinks in memory and forbid network.
const CLI = fs.realpathSync("node_modules/trigger.dev");
const CORE = path.dirname(
  createRequire(path.join(CLI, "package.json")).resolve(
    "@trigger.dev/core/package.json",
  ),
);
const req = createRequire(path.join(CORE, "package.json"));
const load = (rel) => import(pathToFileURL(path.join(CORE, rel)).href);
const api = req("@opentelemetry/api");
const { TraceFlags, trace, context } = api;
const { OTLPTraceExporter } = req("@opentelemetry/exporter-trace-otlp-http");
const { OTLPLogExporter } = req("@opentelemetry/exporter-logs-otlp-http");
const { OTLPMetricExporter } = req("@opentelemetry/exporter-metrics-otlp-http");
const { ExportResultCode } = req("@opentelemetry/core");
const native = [],
  external = [];
/** Retain only span linkage and bounded probe fields at the in-memory export boundary. */
const snapshot = (s) => ({
  name: s.name,
  traceId: s.spanContext().traceId,
  spanId: s.spanContext().spanId,
  parentSpanId: s.parentSpanContext?.spanId,
  parentTraceId: s.parentSpanContext?.traceId,
  runId: s.attributes["$metadata.ctx.run.id"],
  worker: s.attributes["$metadata.worker.version"],
  partial: s.attributes["$span.partial"] === true,
  partialFor: s.attributes["$span.span_id"],
  attempt: s.attributes["$span.attempt"] === true,
  probePhase:
    {
      "child completion packet": "completion-packet",
      "child completion IPC": "completion-ipc",
    }[s.name] ?? s.attributes["harness.phase"],
  outcome: s.attributes["hackerai.child_completion.outcome"],
  probeVersion: s.attributes["hackerai.child_completion.version"],
  resultOk: s.attributes["hackerai.child_completion.result_ok"],
  workerRunning: s.attributes["hackerai.child_completion.worker_running"],
  workerCancelled: s.attributes["hackerai.child_completion.worker_cancelled"],
  processConnected: s.attributes["hackerai.child_completion.process_connected"],
  probeAttempt: s.attributes["hackerai.child_completion.attempt"],
});
// In-memory sink substitution only. Actual SDK constructor, provider, context manager,
// processors, partial snapshots and external wrapper stay unchanged. No network.
OTLPTraceExporter.prototype.export = function (spans, cb) {
  native.push(...spans.map(snapshot));
  cb({ code: ExportResultCode.SUCCESS });
};
OTLPLogExporter.prototype.export = function (_records, cb) {
  cb({ code: ExportResultCode.SUCCESS });
};
OTLPMetricExporter.prototype.export = function (_metrics, cb) {
  cb({ code: ExportResultCode.SUCCESS });
};
for (const protocol of ["node:http", "node:https"]) {
  const m = req(protocol);
  m.request = () => {
    throw new Error("HARNESS_NETWORK_FORBIDDEN");
  };
  m.get = () => {
    throw new Error("HARNESS_NETWORK_FORBIDDEN");
  };
}
globalThis.fetch = () => Promise.reject(new Error("HARNESS_NETWORK_FORBIDDEN"));
const { TracingSDK } = await load("dist/esm/v3/otel/tracingSDK.js");
const { TriggerTracer } = await load("dist/esm/v3/tracer.js");
const { TaskExecutor } = await load("dist/esm/v3/workers/taskExecutor.js");
const { createChildCompletionProbe } = await import(
  pathToFileURL(
    path.join(CLI, "dist/esm/entryPoints/child-completion-probe.js"),
  ).href
);
const { taskContext } = await load("dist/esm/v3/task-context-api.js");
const { traceContext } = await load("dist/esm/v3/trace-context-api.js");
const { StandardTraceContextManager } = await load(
  "dist/esm/v3/traceContext/manager.js",
);
const manager = new StandardTraceContextManager();
traceContext.setGlobalManager(manager);
const sdk = new TracingSDK({
  url: "http://127.0.0.1:1/never-used",
  diagLogLevel: "none",
  forceFlushTimeoutMillis: 1000,
  hostMetrics: false,
  nodejsRuntimeMetrics: false,
  filesystemMetrics: false,
  diskIoMetrics: false,
  instrumentations: [],
  exporters: [
    {
      export(spans, cb) {
        external.push(...spans.map(snapshot));
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    },
  ],
});
const tracer = new TriggerTracer({
  tracer: sdk.getTracer("trigger-dev-worker", "4.7.7"),
  logger: sdk.getLogger("trigger-dev-worker", "4.7.7"),
});
const cases = [];
const definitions = [
  ["normal-cold", false],
  ["external-warm", true],
  ["normal-warm", false],
  ["external-warm-two", true],
];
try {
  for (let i = 0; i < definitions.length; i++) {
    const [name, isExternal] = definitions[i];
    // Same SDK/provider/tracer/manager across runs; match worker reset/boot sequencing.
    taskContext.disable();
    manager.reset();
    const internalTraceId = (i + 1).toString(16).padStart(32, "0"),
      internalParent = (i + 17).toString(16).padStart(16, "0");
    const externalTraceId = (i + 101).toString(16).padStart(32, "0"),
      externalParent = (i + 117).toString(16).padStart(16, "0");
    manager.traceContext = {
      traceparent: `00-${internalTraceId}-${internalParent}-01`,
      ...(isExternal
        ? {
            external: {
              traceparent: `00-${externalTraceId}-${externalParent}-01`,
            },
          }
        : {}),
    };
    const runId = `run_harness_${i}`;
    const ctx = {
      run: { id: runId, isTest: true, isReplay: false, tags: [] },
      task: { id: "agent-long", filePath: "trigger/agent-long.ts" },
      attempt: { number: 1, id: `attempt_${i}` },
      queue: { id: "queue_harness", name: "harness" },
      environment: { id: "env_harness", type: "DEVELOPMENT" },
      organization: { id: "org_harness", slug: "harness", name: "harness" },
      project: { id: "proj_harness", ref: "proj_harness", name: "harness" },
      machine: { name: "small-1x", cpu: 1, memory: 1, centsPerMs: 0 },
    };
    taskContext.setGlobalTaskContext({
      ctx,
      worker: { id: "worker_harness", version: "harness-only" },
      isWarmStart: i > 0,
    });
    const task = { id: "agent-long", fns: { run: async () => ({ ok: true }) } };
    const executor = new TaskExecutor(task, {
      tracingSDK: sdk,
      tracer,
      consoleInterceptor: { intercept: (_c, fn) => fn() },
      isWarmStart: i > 0,
      executionCount: i + 1,
    });
    const result = await executor.execute(
      {
        run: { id: runId, payload: "{}", payloadType: "application/json" },
        attempt: { number: 1 },
      },
      ctx,
      new AbortController().signal,
    );
    assert.equal(
      result.result.ok,
      true,
      "actual TaskExecutor successful synthetic body",
    );
    const enabledAfterExecute =
      !taskContext.isRunDisabled && taskContext.ctx?.run.id === runId;
    assert.equal(enabledAfterExecute, true);
    const activeAfterExecute = trace.getSpanContext(context.active());
    let unparentedControl;
    if (i === 0) {
      const wrong = tracer.startSpan("harness.no-explicit-parent", {
        attributes: { "harness.phase": "negative-control" },
      });
      const wrongContext = wrong.spanContext();
      wrong.end();
      assert.notEqual(wrongContext.traceId, internalTraceId);
      unparentedControl = {
        createsDifferentTrace: true,
        traceId: wrongContext.traceId,
      };
    }
    const probe = createChildCompletionProbe({
      tracer,
      getParentContext: () => manager.extractContext(),
      execution: { task: { id: "agent-long" }, attempt: { number: 1 } },
      result: result.result,
      isRunning: true,
      isCancelled: false,
      connected: true,
    });
    const packet = { fixture: "synthetic-only" };
    assert.equal(probe.packetReady(packet), packet);
    const originalPromise = Promise.resolve();
    probe.observeReturn(originalPromise);
    await originalPromise;
    await Promise.resolve();
    await sdk.flush();
    const ns = native.filter((s) => s.runId === runId),
      es = external.filter((s) => s.runId === runId);
    for (const phase of ["completion-packet", "completion-ipc"]) {
      const n = ns.filter((s) => s.probePhase === phase),
        e = es.filter((s) => s.probePhase === phase);
      assert.equal(n.length, 2, `${name} ${phase} native partial+final`);
      assert.equal(n.filter((s) => s.partial).length, 1);
      const final = n.find((s) => !s.partial),
        partial = n.find((s) => s.partial);
      assert.equal(final.traceId, internalTraceId);
      assert.equal(final.parentSpanId, internalParent);
      assert.equal(partial.partialFor, final.spanId);
      assert.equal(partial.traceId, internalTraceId);
      assert.equal(final.probeVersion, 1);
      assert.equal(final.resultOk, true);
      assert.equal(final.workerRunning, true);
      assert.equal(final.workerCancelled, false);
      assert.equal(final.processConnected, true);
      assert.equal(final.probeAttempt, 1);
      assert.equal(
        final.outcome,
        phase === "completion-packet"
          ? "packet_ready"
          : "returned_unacknowledged",
      );
      assert.equal(
        e.length,
        1,
        "external route has final only: partial pipeline is native route only",
      );
      if (isExternal) {
        assert.equal(e[0].traceId, externalTraceId);
        assert.equal(e[0].parentSpanId, internalParent);
      }
    }
    cases.push({
      name,
      runId,
      unparentedControl,
      enabledAfterExecute,
      activeAfterExecute: activeAfterExecute ?? null,
      internalTraceId,
      internalParent,
      externalTraceId: isExternal ? externalTraceId : null,
      externalParent: isExternal ? externalParent : null,
      nativeSpans: ns,
      externalSpans: es,
    });
  }
  const sourceRun = taskContext.ctx.run.id;
  const delayedProbe = createChildCompletionProbe({
    tracer,
    getParentContext: () => manager.extractContext(),
    execution: { task: { id: "agent-long" }, attempt: { number: 1 } },
    result: { ok: false },
    isRunning: true,
    isCancelled: false,
    connected: true,
  });
  delayedProbe.packetReady({ fixture: "delayed-only" });
  let resolvePending;
  const pending = new Promise((resolve) => {
    resolvePending = resolve;
  });
  delayedProbe.observeReturn(pending);
  await sdk.flush();
  const prior = taskContext.ctx;
  const ipcBefore = native.filter(
    (s) => s.name === "child completion IPC" && s.runId === sourceRun,
  );
  // The first completed control plus this pending send: partial+final, then partial only.
  assert.equal(ipcBefore.length, 3);
  assert.equal(ipcBefore.at(-1).partial, true);
  assert.equal(ipcBefore.at(-1).resultOk, false);
  const sourceTrace = ipcBefore.at(-1).traceId,
    pendingSpanId = ipcBefore.at(-1).partialFor;
  taskContext.disable();
  manager.reset();
  taskContext.setGlobalTaskContext({
    ctx: { ...prior, run: { ...prior.run, id: "run_harness_next" } },
    worker: { id: "worker_harness", version: "harness-only" },
    isWarmStart: true,
  });
  const nextExternalTrace = "000000000000000000000000000000ee";
  manager.traceContext = {
    traceparent: "00-000000000000000000000000000000dd-00000000000000dd-01",
    external: { traceparent: `00-${nextExternalTrace}-00000000000000ee-01` },
  };
  resolvePending();
  await pending;
  await Promise.resolve();
  await sdk.flush();
  const delayedNative = native.filter(
    (s) =>
      s.name === "child completion IPC" &&
      (s.spanId === pendingSpanId || s.partialFor === pendingSpanId),
  );
  assert.equal(delayedNative.length, 2);
  assert.equal(
    delayedNative.every(
      (s) =>
        s.runId === sourceRun &&
        s.traceId === sourceTrace &&
        s.resultOk === false,
    ),
    true,
  );
  assert.equal(
    delayedNative.find((s) => !s.partial).outcome,
    "returned_unacknowledged",
  );
  const delayedExternal = external.filter(
    (s) => s.name === "child completion IPC" && s.spanId === pendingSpanId,
  );
  const delayedWarmFinal = {
    sourceRun,
    sourceTrace,
    pendingNativePartialBeforeReset: true,
    native: delayedNative,
    external: delayedExternal,
    nextExternalTrace,
    nativeAttributionStable: true,
    externalAmbientRewriteObserved: delayedExternal.some(
      (s) => s.traceId === nextExternalTrace,
    ),
  };
  const out = {
    networkAllowed: false,
    actualClasses: [
      "TracingSDK",
      "TaskExecutor",
      "TriggerTracer",
      "TaskContextSpanProcessor",
      "ExternalSpanExporterWrapper",
      "StandardTraceContextManager",
      "createChildCompletionProbe",
    ],
    delayedWarmFinal,
    mode:
      process.env.TRIGGER_OTEL_BATCH_PROCESSING_ENABLED === "1"
        ? "batch"
        : "simple",
    cases,
    limits: [
      "Synthetic in-process SDK path; no production ingestion, task scheduler, controller ACK or physical kill proof.",
      "Manual sibling uses internal incoming parent; external exporter rewrites trace id but only overrides parent span id on Attempt spans.",
    ],
    pass: true,
  };
  console.log(
    JSON.stringify({
      pass: true,
      mode: out.mode,
      cases: cases.length,
      nativeSpans: native.length,
      externalSpans: external.length,
    }),
  );
} finally {
  await sdk.shutdown();
}
