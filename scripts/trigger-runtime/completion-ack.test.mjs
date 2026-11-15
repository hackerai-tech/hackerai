import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The managed run controller drops an attempt completion the supervisor never
// acknowledged and moves on to its next run. The repository patches
// @trigger.dev/core so that single idempotent request survives a longer
// supervisor outage. Load the copy the trigger.dev CLI bundles into deployed
// controllers, in both published formats, and drive it over loopback HTTP.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliDir = realpathSync(join(root, "node_modules/trigger.dev"));
const requireFromCli = createRequire(join(cliDir, "package.json"));
const corePackagePath = requireFromCli.resolve(
  "@trigger.dev/core/package.json",
);
const coreExports = JSON.parse(readFileSync(corePackagePath, "utf8")).exports;
const importCore = (subpath) =>
  import(
    pathToFileURL(
      join(dirname(corePackagePath), coreExports[subpath].import.default),
    ).href
  );

const esm = await importCore("./v3/runEngineWorker");
const { wrapZodFetch } = await importCore("./v3/zodfetch");
const cjsPath = requireFromCli.resolve("@trigger.dev/core/v3/runEngineWorker");
const cjs = requireFromCli("@trigger.dev/core/v3/runEngineWorker");
const clients = [
  ["ESM", esm.WorkloadHttpClient],
  ["CommonJS", cjs.WorkloadHttpClient],
];

const RUN_ID = "run_test_completion_ack";
const SNAPSHOT_ID = "snapshot_test_executing";
const COMPLETE_PATH = `/api/v1/workload-actions/runs/${RUN_ID}/snapshots/${SNAPSHOT_ID}/attempts/complete`;
const COMPLETION = {
  completion: {
    id: RUN_ID,
    ok: true,
    output: '{"fixture":true}',
    outputType: "application/json",
    usage: { durationMs: 1 },
  },
};
const ACK = {
  result: {
    attemptStatus: "RUN_FINISHED",
    snapshot: {
      id: "snapshot_test_internal",
      friendlyId: "snapshot_test_finished",
      executionStatus: "FINISHED",
      description: "test acknowledgement",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    run: {
      id: "run_test_internal",
      friendlyId: RUN_ID,
      status: "COMPLETED_SUCCESSFULLY",
      attemptNumber: 1,
    },
  },
};

// Only this file's loopback supervisors are reachable; any other destination
// is refused before a socket opens.
const ownedOrigins = new Set();
let refusedFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  if (!ownedOrigins.has(new URL(href).origin)) {
    refusedFetches += 1;
    return Promise.reject(new TypeError("refused non-test destination"));
  }
  return realFetch(input, init);
};
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(refusedFetches, 0);
});

/** Fail the first `failures` completion requests, then acknowledge. */
async function startSupervisor(t, { failures, status = 503, headers = {} }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body });
      const fail = requests.length <= failures;
      res.writeHead(fail ? status : 200, {
        "content-type": "application/json",
        ...(fail ? headers : {}),
      });
      res.end(JSON.stringify(fail ? { error: "unavailable" } : ACK));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  ownedOrigins.add(origin);
  t.after(
    () =>
      new Promise((done) => {
        ownedOrigins.delete(origin);
        server.closeAllConnections();
        server.close(done);
      }),
  );
  return { origin, requests };
}

const complete = (Client, origin) =>
  new Client({
    workerApiUrl: origin,
    runnerId: "runner_test",
    deploymentId: "deployment_test",
    deploymentVersion: "20260101.1",
    projectRef: "proj_test",
  }).completeRunAttempt(RUN_ID, SNAPSHOT_ID, COMPLETION);

/** Every retry must resend the same completion for the same run and snapshot. */
function assertSameCompletion(requests) {
  for (const request of requests)
    assert.deepEqual(request, {
      method: "POST",
      path: COMPLETE_PATH,
      body: JSON.stringify(COMPLETION),
    });
}

test("loads both published formats of the CLI's @trigger.dev/core", () => {
  assert.match(cjsPath, /[\\/]dist[\\/]commonjs[\\/]/);
  assert.notEqual(esm.WorkloadHttpClient, cjs.WorkloadHttpClient);
});

describe("attempt completion acknowledgement", { concurrency: true }, () => {
  for (const [format, Client] of clients) {
    test(
      `${format} client is acknowledged after five 503 responses`,
      { timeout: 90_000 },
      async (t) => {
        const supervisor = await startSupervisor(t, { failures: 5 });
        const result = await complete(Client, supervisor.origin);
        assert.equal(result.success, true);
        assert.equal(result.data.result.attemptStatus, "RUN_FINISHED");
        assert.equal(supervisor.requests.length, 6);
        assertSameCompletion(supervisor.requests);
      },
    );

    test(
      `${format} client stops after eight 503 responses`,
      { timeout: 90_000 },
      async (t) => {
        const supervisor = await startSupervisor(t, { failures: Infinity });
        const result = await complete(Client, supervisor.origin);
        assert.equal(result.success, false);
        assert.equal(result.statusCode, 503);
        assert.equal(supervisor.requests.length, 8);
        assertSameCompletion(supervisor.requests);
      },
    );

    test(
      `${format} client sends one request when acknowledged immediately`,
      { timeout: 90_000 },
      async (t) => {
        const supervisor = await startSupervisor(t, { failures: 0 });
        const result = await complete(Client, supervisor.origin);
        assert.equal(result.success, true);
        assert.equal(supervisor.requests.length, 1);
        assertSameCompletion(supervisor.requests);
      },
    );

    test(
      `${format} client does not retry a rejected completion`,
      { timeout: 90_000 },
      async (t) => {
        for (const rejection of [
          { status: 400 },
          { status: 503, headers: { "x-should-retry": "false" } },
        ]) {
          const supervisor = await startSupervisor(t, {
            failures: Infinity,
            ...rejection,
          });
          const result = await complete(Client, supervisor.origin);
          assert.equal(result.success, false);
          assert.equal(result.statusCode, rejection.status);
          assert.equal(supervisor.requests.length, 1);
          assertSameCompletion(supervisor.requests);
        }
      },
    );
  }

  // The unpatched completeRunAttempt passed no retry options, so it used the
  // SDK's default wrapZodFetch budget. That budget gives up before the sixth
  // request a recovering supervisor would have acknowledged.
  test(
    "the default request budget gives up before a recovering supervisor acknowledges",
    { timeout: 90_000 },
    async (t) => {
      const supervisor = await startSupervisor(t, { failures: 5 });
      const result = await wrapZodFetch(
        esm.WorkloadRunAttemptCompleteResponseBody,
        `${supervisor.origin}${COMPLETE_PATH}`,
        { method: "POST", body: JSON.stringify(COMPLETION) },
      );
      assert.equal(result.success, false);
      assert.equal(supervisor.requests.length, 5);
      assertSameCompletion(supervisor.requests);
    },
  );
});
