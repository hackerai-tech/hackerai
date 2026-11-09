import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createProxyDispatcher,
  formatGatewayError,
  gatewayRequest,
  loadResearchKey,
  parseArgs,
  runResearch,
  readPayload,
  readProtectedJson,
} from "./run-research.mjs";

async function localKeyFixture(t, value) {
  const homeDir = await mkdtemp(join(tmpdir(), "pm-research-key-test-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const keyPath = join(homeDir, ".config", "hackerai", "pm-research.key");
  await mkdir(join(homeDir, ".config", "hackerai"), { recursive: true });
  if (value !== undefined) await writeFile(keyPath, value, { mode: 0o600 });
  return { homeDir, keyPath };
}

test("loads the machine key without an exported environment variable", async (t) => {
  const { homeDir } = await localKeyFixture(t, "synthetic-local-key\n");
  assert.equal(
    await loadResearchKey({ homeDir, env: {} }),
    "synthetic-local-key",
  );
  assert.equal(
    await loadResearchKey({
      homeDir,
      env: { HACKERAI_PM_USER_RESEARCH_KEY: "synthetic-env-key" },
    }),
    "synthetic-local-key",
  );
});

test("falls back to the environment only when the local file is absent", async (t) => {
  const { homeDir } = await localKeyFixture(t);
  assert.equal(
    await loadResearchKey({
      homeDir,
      env: { HACKERAI_PM_USER_RESEARCH_KEY: "synthetic-env-key\n" },
    }),
    "synthetic-env-key",
  );
  await assert.rejects(
    loadResearchKey({ homeDir, env: {} }),
    /key not found: checked/,
  );
});

test("rejects malformed local keys without exposing values or using the environment", async (t) => {
  for (const value of [
    "",
    "\n",
    "private-test-value\nsecond-token",
    "private-test-value with spaces",
  ]) {
    const { homeDir } = await localKeyFixture(t, value);
    await assert.rejects(
      loadResearchKey({
        homeDir,
        env: { HACKERAI_PM_USER_RESEARCH_KEY: "synthetic-env-key" },
      }),
      (error) => {
        assert.match(error.message, /nonempty single token/);
        assert.doesNotMatch(
          error.message,
          /private-test-value|synthetic-env-key/,
        );
        return true;
      },
    );
  }
});

test("rejects public, oversized, and non-file local credentials", async (t) => {
  const { homeDir, keyPath } = await localKeyFixture(t, "synthetic-local-key");
  await chmod(keyPath, 0o644);
  await assert.rejects(
    loadResearchKey({ homeDir, env: {} }),
    /owner-only regular file/,
  );
  await chmod(keyPath, 0o600);
  await writeFile(keyPath, "x".repeat(4097));
  await assert.rejects(
    loadResearchKey({ homeDir, env: {} }),
    /larger than 4 KiB/,
  );
  await rm(keyPath);
  await mkdir(keyPath, { mode: 0o700 });
  await assert.rejects(
    loadResearchKey({ homeDir, env: {} }),
    /owner-only regular file/,
  );
});

let origin;
let proxy;
let originUrl;
let proxyUrl;
let proxyRequests = 0;

before(async () => {
  origin = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ authorization: request.headers.authorization }),
    );
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  originUrl = `http://127.0.0.1:${originAddress.port}/research`;

  proxy = createServer((request, response) => {
    proxyRequests += 1;
    const target = new URL(request.url);
    const forwarded = httpRequest(
      target,
      { method: request.method, headers: request.headers },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 500, upstream.headers);
        upstream.pipe(response);
      },
    );
    request.pipe(forwarded);
  });
  proxy.on("connect", (request, clientSocket, head) => {
    proxyRequests += 1;
    const [host, port] = request.url.split(":");
    const upstreamSocket = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
});

after(async () => {
  await Promise.all([
    new Promise((resolve, reject) =>
      origin.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
});

test("gateway requests use the configured HTTP proxy", async () => {
  const dispatcher = createProxyDispatcher({
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "",
  });

  try {
    const body = await gatewayRequest(
      originUrl,
      "synthetic-test-key",
      {},
      {
        dispatcher,
      },
    );

    assert.equal(proxyRequests, 1);
    assert.equal(body.authorization, "Bearer synthetic-test-key");
  } finally {
    await dispatcher.close();
  }
});

test("gateway requests do not create a dispatcher without proxy variables", () => {
  assert.equal(createProxyDispatcher({}), undefined);
});

test("gateway errors include bounded validation details without rejected input", async () => {
  await assert.rejects(
    gatewayRequest(
      originUrl,
      "synthetic-test-key",
      {},
      {
        request: async () =>
          new Response(
            JSON.stringify({
              error: "invalid_payload",
              issues: [
                {
                  code: "invalid_type",
                  path: ["cohortSelectedAt", "private-rejected-input"],
                  message: "Rejected private value private-rejected-input",
                  input: "private rejected input",
                },
              ],
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    ),
    (error) => {
      assert.match(
        error.message,
        /cohortSelectedAt\.field: has an invalid type/,
      );
      assert.doesNotMatch(error.message, /private rejected input/);
      assert.doesNotMatch(error.message, /private-rejected-input/);
      return true;
    },
  );
});

test("gateway error formatting bounds issue count and message length", () => {
  const error = formatGatewayError(400, {
    error: "invalid_payload",
    issues: Array.from({ length: 12 }, (_, index) => ({
      path: ["field", index, ...Array.from({ length: 20 }, () => "nested")],
      message: "x".repeat(500),
    })),
  });

  assert.match(error, /^Research gateway returned 400: invalid_payload/);
  assert.match(error, /field\.7\.nested/);
  assert.doesNotMatch(error, /field\.8\.nested/);
  assert.doesNotMatch(error, /(?:\.nested){7}/);
  assert.ok(error.length < 2_300);
});

test("gateway error formatting allow-lists the top-level error code", () => {
  const error = formatGatewayError(502, {
    error: "private-rejected-input",
    issues: [],
  });

  assert.equal(error, "Research gateway returned 502: request_failed");
});

async function requestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "research-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloadPath = join(root, "request.json");
  await writeFile(
    payloadPath,
    JSON.stringify({
      question: "synthetic research question",
      userIds: ["user_test"],
    }),
    { mode: 0o600 },
  );
  return { root, payloadPath, handlePath: `${payloadPath}.run.json` };
}
const quiet = { log: () => {} };

test("stdin starts a bounded request and persists only a protected recovery handle", async (t) => {
  const f = await requestFixture(t);
  const args = parseArgs([
    "--payload",
    "-",
    "--handle",
    f.handlePath,
    "--no-wait",
  ]);
  const result = await runResearch(args, {
    ...quiet,
    key: "synthetic-secret",
    input: [JSON.stringify({ question: "private request text" })],
    request: async (url, key, init) => {
      assert.equal(
        String(url),
        "https://hackerai.co/api/internal/user-research",
      );
      assert.equal(init.method, "POST");
      assert.ok(init.headers["idempotency-key"]);
      return { runId: "run_test" };
    },
  });
  assert.equal(result.runId, "run_test");
  assert.equal((await stat(f.handlePath)).mode & 0o077, 0);
  assert.doesNotMatch(
    await readFile(f.handlePath, "utf8"),
    /synthetic-secret|private request text/,
  );
  await assert.rejects(readPayload(args, ["x".repeat(32769)]), /32 KiB/);
});

test("a lost start response keeps the same retry key; resuming a known run only performs GET", async (t) => {
  const f = await requestFixture(t);
  const args = parseArgs(["--payload", f.payloadPath, "--no-wait"]);
  let keySeen;
  await assert.rejects(
    runResearch(args, {
      ...quiet,
      request: async (url, key, init) => {
        keySeen = init.headers["idempotency-key"];
        throw new Error("response lost after server acceptance");
      },
    }),
  );
  const result = await runResearch(args, {
    ...quiet,
    request: async (url, key, init) => {
      assert.equal(init.headers["idempotency-key"], keySeen);
      return { runId: "run_accepted" };
    },
  });
  assert.equal(result.runId, "run_accepted");
  await rm(f.payloadPath);
  const resumed = await runResearch(parseArgs(["--resume", f.handlePath]), {
    ...quiet,
    request: async (url, key, init) => {
      assert.equal(init, undefined);
      assert.equal(url.searchParams.get("runId"), "run_accepted");
      return { status: "completed", result: { analysisId: "analysis_test" } };
    },
  });
  assert.equal(resumed.analysisId, "analysis_test");
});

test("changed payloads and expired unknown submissions cannot replay an existing handle", async (t) => {
  const f = await requestFixture(t);
  const args = parseArgs(["--payload", f.payloadPath, "--no-wait"]);
  const createdAt = Date.now() - 24 * 60 * 60 * 1000;
  await assert.rejects(
    runResearch(args, {
      ...quiet,
      now: () => createdAt,
      request: async () => {
        throw new Error("lost");
      },
    }),
  );
  let calls = 0;
  const request = async () => {
    calls++;
    return { runId: "run_wrong" };
  };
  await assert.rejects(
    runResearch(args, { ...quiet, request }),
    /do not replay/,
  );
  await writeFile(
    f.payloadPath,
    JSON.stringify({ question: "changed question" }),
  );
  await assert.rejects(
    runResearch(args, { ...quiet, request }),
    /different request/,
  );
  await assert.rejects(
    runResearch(parseArgs(["--resume", f.handlePath]), { ...quiet, request }),
    /unknown/,
  );
  assert.equal(calls, 0);
});

test("status and no-wait resume reuse the known run without a new submission", async (t) => {
  const f = await requestFixture(t);
  await runResearch(parseArgs(["--payload", f.payloadPath, "--no-wait"]), {
    ...quiet,
    request: async () => ({ runId: "run_known" }),
  });
  let calls = 0;
  const request = async (url, key, init) => {
    calls++;
    assert.equal(init, undefined);
    return { status: "running" };
  };
  assert.equal(
    (
      await runResearch(parseArgs(["--status", f.handlePath]), {
        ...quiet,
        request,
      })
    ).status,
    "running",
  );
  assert.equal(calls, 1);
  await runResearch(parseArgs(["--resume", f.handlePath, "--no-wait"]), {
    ...quiet,
    request,
  });
  assert.equal(calls, 1);
});

test("payloads and handles reject public files, symlinks and malformed JSON without echoing content", async (t) => {
  const f = await requestFixture(t);
  await chmod(f.payloadPath, 0o644);
  await assert.rejects(readProtectedJson(f.payloadPath, 32768), /owner-only/);
  await chmod(f.payloadPath, 0o600);
  await writeFile(f.payloadPath, "private invalid content");
  await assert.rejects(readProtectedJson(f.payloadPath, 32768), (error) => {
    assert.doesNotMatch(error.message, /private invalid content/);
    return true;
  });
  await symlink(f.payloadPath, f.handlePath);
  await assert.rejects(readProtectedJson(f.handlePath, 4096));
  for (const argv of [
    [],
    ["--payload", "-"],
    ["--status", "a", "--payload", "b"],
    ["--payload", "a", "--payload", "b"],
  ])
    assert.throws(() => parseArgs(argv));
});

test("cohort exports compile selection before submission and omit raw queries and payer identities", async (t) => {
  const f = await requestFixture(t);
  const cohortPath = join(f.root, "cohort.json");
  await writeFile(
    f.payloadPath,
    JSON.stringify({
      question: "bounded cohort question",
      cohortLabel: "selected group",
    }),
  );
  await writeFile(
    cohortPath,
    JSON.stringify({
      posthogProjectId: 144137,
      cohortSelectedAt: Date.now(),
      selectionQuery: "private selection query",
      candidates: [
        {
          userId: "user_selected",
          payerId: "cus_private",
          internal: false,
          test: false,
          fraud: false,
        },
      ],
    }),
    { mode: 0o600 },
  );
  let posted;
  await runResearch(
    parseArgs([
      "--payload",
      f.payloadPath,
      "--cohort",
      cohortPath,
      "--no-wait",
    ]),
    {
      ...quiet,
      request: async (url, key, init) => {
        posted = JSON.parse(init.body);
        return { runId: "run_cohort" };
      },
    },
  );
  assert.deepEqual(posted.userIds, ["user_selected"]);
  assert.doesNotMatch(
    JSON.stringify(posted),
    /private selection query|cus_private/,
  );
});

test("concurrent starts publish one complete retry identity and converge on the same accepted run", async (t) => {
  const f = await requestFixture(t);
  const args = parseArgs(["--payload", f.payloadPath, "--no-wait"]);
  const keys = [];
  const request = async (url, key, init) => {
    keys.push(init.headers["idempotency-key"]);
    return { runId: "run_shared" };
  };
  const results = await Promise.all([
    runResearch(args, { ...quiet, request }),
    runResearch(args, { ...quiet, request }),
  ]);
  assert.ok(results.every((result) => result.runId === "run_shared"));
  assert.equal(new Set(keys).size, 1);
  assert.equal(
    JSON.parse(await readFile(f.handlePath, "utf8")).runId,
    "run_shared",
  );
});
