"use strict";
// Installed Trigger SDK + real Node fetch/Undici transport contract for the
// status-read diagnostics. Run directly with `node <this file>` from the repo
// root (Jest also runs it in a child with a scrubbed environment). It uses only
// a local ephemeral HTTP server and a synthetic token, then prints one JSON line
// with fixed stage labels and runtime versions; never URLs, bodies or errors.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../../../..");
const FIXTURE = "trigger-run-read-transport";
const TOKEN = "tr_dev_synthetic_fixture_token";
const RUN_ID = "run_fixturecontract0000000001";
const WAIT_MS = 5_000;

// Never let a host Trigger configuration or credential reach the SDK.
for (const key of Object.keys(process.env))
  if (key.startsWith("TRIGGER_")) delete process.env[key];

// Compile only this repository's lib/*.ts sources for the child runtime. The
// documentation-deprecated CJS hook works on every supported Node release.
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  if (!filename.startsWith(path.join(root, "lib") + path.sep))
    throw new Error("Unexpected TypeScript module");
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  module._compile(outputText, filename);
};

class ContractFailure extends Error {}
const check = (condition, label) => {
  if (!condition) throw new ContractFailure(label);
};
const version = (value) =>
  typeof value === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
    ? value
    : undefined;

const within = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ContractFailure(`${label}_timeout`)),
        WAIT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new ContractFailure(`${label}_timeout`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const runBody = (extra = {}) =>
  JSON.stringify({
    id: RUN_ID,
    status: "EXECUTING",
    taskIdentifier: "agent-long",
    isQueued: false,
    isExecuting: true,
    isWaiting: false,
    isCompleted: false,
    isSuccess: false,
    isFailed: false,
    isCancelled: false,
    isTest: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tags: [],
    costInCents: 0,
    baseCostInCents: 0,
    durationMs: 0,
    depth: 0,
    triggerFunction: "trigger",
    relatedRuns: {},
    metadata: { private: "PRIVATE_METADATA" },
    ...extra,
  });

async function main(record) {
  const incoming = [];
  const waiters = [];
  const received = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    received.push({
      method: req.method,
      path: req.url,
      authorized: req.headers.authorization === `Bearer ${TOKEN}`,
      headerNames: Object.keys(req.headers).sort(),
    });
    const entry = { req, res };
    const waiter = waiters.shift();
    if (waiter) waiter(entry);
    else incoming.push(entry);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const nextRequest = (label) =>
    within(
      incoming.length
        ? Promise.resolve(incoming.shift())
        : new Promise((resolve) => waiters.push(resolve)),
      label,
    );
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // Exercise the production env/default target resolution, not configure().
    process.env.TRIGGER_API_URL = origin;
    process.env.TRIGGER_SECRET_KEY = TOKEN;
    const { registerServiceTransportObserver } = require(
      path.join(root, "lib/db/service-transport-observation.node.ts"),
    );
    const { createTriggerRunReadDiagnostics } = require(
      path.join(root, "lib/api/trigger-run-read-diagnostics.ts"),
    );
    registerServiceTransportObserver();
    const { ApiError, runs } = require("@trigger.dev/sdk");
    const apiPath = `/api/v3/runs/${RUN_ID}`;
    const expectedKeys = [
      "trigger_run_read_api_body",
      "trigger_run_read_api_body_elapsed_capped",
      "trigger_run_read_api_body_elapsed_ms",
      "trigger_run_read_diagnostic_version",
      "trigger_run_read_transport_diagnostic_version",
      "trigger_run_read_transport_request_count",
      "trigger_run_read_transport_request_count_capped",
      "trigger_run_read_transport_state",
    ];
    const snap = (diagnostics, label) => {
      const value = diagnostics.snapshot();
      check(
        JSON.stringify(Object.keys(value).sort()) ===
          JSON.stringify(expectedKeys),
        `${label}_snapshot_fields`,
      );
      check(
        !/127\.0\.0\.1|PRIVATE|run_|api\/v3|fixture|Bearer/.test(
          JSON.stringify(Object.values(value)),
        ),
        `${label}_snapshot_bounded`,
      );
      return value;
    };
    const expectState = (diagnostics, label, state, count, body) => {
      const value = snap(diagnostics, label);
      check(value.trigger_run_read_transport_state === state, `${label}_state`);
      check(
        value.trigger_run_read_transport_request_count === count &&
          value.trigger_run_read_transport_request_count_capped === false,
        `${label}_count`,
      );
      check(value.trigger_run_read_api_body === body, `${label}_body`);
    };
    // Start a read inside the observation and keep the SDK's own promise.
    const start = (diagnostics, options) => {
      let sdkPromise;
      const returned = diagnostics.run(
        () => (sdkPromise = runs.retrieve(RUN_ID, options)),
      );
      check(returned === sdkPromise, "operation_identity");
      const settled = returned.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      return settled;
    };

    // 1-4: one read through every phase, then a delayed presigned packet.
    {
      const d = createTriggerRunReadDiagnostics({ runId: RUN_ID });
      expectState(d, "before_dispatch", "no_request_event", 0, "not_observed");
      const settled = start(d, d.requestOptions);
      const api = await nextRequest("api_request");
      expectState(
        d,
        "request_before_headers",
        "request_body_sent",
        1,
        "not_observed",
      );
      record("request_before_headers");

      api.res.writeHead(200, { "content-type": "application/json" });
      api.res.flushHeaders();
      await waitFor(
        () =>
          d.snapshot().trigger_run_read_transport_state ===
          "response_headers_received",
        "response_headers",
      );
      expectState(
        d,
        "headers_held_body",
        "response_headers_received",
        1,
        "not_observed",
      );
      record("headers_held_body");

      api.res.end(
        runBody({ payloadPresignedUrl: `${origin}/packets/private-payload` }),
      );
      const packet = await nextRequest("packet_request");
      check(packet.req.url === "/packets/private-payload", "packet_path");
      // A different path inside the same context is not a matching dispatch.
      expectState(
        d,
        "validated_body_before_packet",
        "response_headers_received",
        1,
        "validated_body_observed",
      );
      record("validated_body_before_packet");

      json(packet.res, 200, JSON.stringify({ value: "PRIVATE_PAYLOAD" }));
      const result = await within(settled, "payload_result");
      d.finish();
      check(
        result.value?.id === RUN_ID &&
          result.value.status === "EXECUTING" &&
          result.value.payload?.value === "PRIVATE_PAYLOAD",
        "payload_preserved",
      );
      check(
        received.length === 2 &&
          received[0].method === "GET" &&
          received[0].path === apiPath &&
          received[0].authorized,
        "api_request_shape",
      );
      expectState(
        d,
        "payload_result",
        "response_headers_received",
        1,
        "validated_body_observed",
      );
      record("payload_result");
    }

    // 5: a 503 then valid response. The observed call must send exactly what
    // an unobserved baseline sends, and the latest attempt must reset state.
    {
      const retry = Object.freeze({
        maxAttempts: 2,
        minTimeoutInMs: 5,
        maxTimeoutInMs: 5,
        factor: 1,
        randomize: false,
      });
      const retryRead = async (observed) => {
        const from = received.length;
        // An explicit base URL is the contract for a configured SDK client.
        const d = createTriggerRunReadDiagnostics({
          runId: RUN_ID,
          baseURL: `${origin}/`,
        });
        const options = { ...d.requestOptions, retry };
        const settled = observed
          ? start(d, options)
          : runs.retrieve(RUN_ID, options).then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
        const first = await nextRequest("retry_first_request");
        json(first.res, 503, JSON.stringify({ error: "PRIVATE_UNAVAILABLE" }));
        const second = await nextRequest("retry_second_request");
        if (observed)
          // The earlier attempt's response headers cannot complete this one.
          expectState(
            d,
            "retry_latest_attempt",
            "request_body_sent",
            2,
            "not_observed",
          );
        json(second.res, 200, runBody());
        const result = await within(settled, "retry_result");
        d.finish();
        check(result.value?.id === RUN_ID, "retry_result_value");
        check(
          JSON.stringify(Object.keys(options).sort()) ===
            JSON.stringify(["onResponseBody", "retry"]),
          "retry_options_unchanged",
        );
        return { d, requests: received.slice(from) };
      };
      const baseline = await retryRead(false);
      const observed = await retryRead(true);
      check(
        observed.requests.length === 2 &&
          JSON.stringify(observed.requests) ===
            JSON.stringify(baseline.requests),
        "retry_requests_match_baseline",
      );
      check(
        observed.requests.every(
          (request) =>
            request.method === "GET" &&
            request.path === apiPath &&
            request.authorized,
        ),
        "retry_request_shape",
      );
      expectState(
        observed.d,
        "retry_valid",
        "response_headers_received",
        2,
        "validated_body_observed",
      );
      record("retry_503_then_valid");
    }

    // 6-8: settled failures keep the SDK's own rejection, without a body mark.
    for (const [label, status, body, errorName] of [
      ["malformed_json", 200, '{"id":', "ApiSchemaValidationError"],
      [
        "schema_rejection",
        200,
        '{"invalid":"PRIVATE"}',
        "ApiSchemaValidationError",
      ],
      ["http_403", 403, '{"error":"PRIVATE_DENIED"}', "PermissionDeniedError"],
    ]) {
      const from = received.length;
      const d = createTriggerRunReadDiagnostics({ runId: RUN_ID });
      const settled = start(d, d.requestOptions);
      json((await nextRequest(`${label}_request`)).res, status, body);
      const result = await within(settled, label);
      d.finish();
      check(
        result.error instanceof ApiError &&
          result.error.constructor.name === errorName &&
          result.error.status === status,
        `${label}_original_error`,
      );
      check(received.length - from === 1, `${label}_single_request`);
      expectState(d, label, "response_headers_received", 1, "not_observed");
      record(label);
    }

    // 9: a non-Undici fetch emits no transport events. A validated body must
    // not be reported as a network phase.
    {
      const nativeFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(runBody(), {
          headers: { "content-type": "application/json" },
        });
      };
      try {
        const d = createTriggerRunReadDiagnostics({ runId: RUN_ID });
        const result = await within(
          start(d, d.requestOptions),
          "non_undici_result",
        );
        d.finish();
        check(result.value?.id === RUN_ID && calls === 1, "non_undici_value");
        expectState(
          d,
          "non_undici_fetch",
          "no_request_event",
          0,
          "validated_body_observed",
        );
      } finally {
        globalThis.fetch = nativeFetch;
      }
      record("non_undici_fetch_not_inferred");
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const stages = [];
let current = "setup";
const record = (label) => {
  stages.push(label);
  current = `after_${label}`;
};
const report = (fields) => {
  let sdkVersion;
  try {
    sdkVersion = version(
      JSON.parse(
        fs.readFileSync(
          path.join(root, "node_modules/@trigger.dev/sdk/package.json"),
          "utf8",
        ),
      ).version,
    );
  } catch {
    sdkVersion = undefined;
  }
  console.log(
    JSON.stringify({
      fixture: FIXTURE,
      fixture_version: 1,
      node_version: version(process.versions.node),
      node_bundled_undici_version: version(process.versions.undici),
      trigger_sdk_version: sdkVersion,
      ...fields,
    }),
  );
};
const guard = setTimeout(() => {
  report({ result: "fail", stage: current, failure: "overall_timeout" });
  process.exit(1);
}, 20_000);
guard.unref();

main(record).then(
  () => {
    clearTimeout(guard);
    report({ result: "pass", stages });
  },
  (error) => {
    clearTimeout(guard);
    const name = error?.constructor?.name;
    report({
      result: "fail",
      stage: current,
      failure:
        error instanceof ContractFailure
          ? error.message
          : typeof name === "string" && /^[A-Za-z]{1,64}$/.test(name)
            ? name
            : "unknown",
      stages,
    });
    process.exitCode = 1;
  },
);
