import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
  rm,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  validateConfig,
  verifyApp,
  health,
  supervise,
  record,
  main,
  probePort,
} from "./qa.mjs";
import { TargetVerificationError } from "./verify-targets.mjs";

const config = () => ({
  environment: "local",
  frontend: "http://127.0.0.1:3100",
  backend: {
    account: "local",
    project: "hackerai",
    deployment: "local-worktree",
    url: "http://127.0.0.1:3210",
  },
  worker: {
    project: "proj_example",
    environment: "development",
    branch: "qa",
    version: "unverified",
  },
  relay: "ws://127.0.0.1:8000",
  app: {
    executable: ".artifacts/qa-app",
    sha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    version: "0.0.0",
  },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "desktop-qa-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function waitFor(file, predicate) {
  for (let i = 0; i < 100; i++) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch {
      /* not ready */
    }
    await delay(30);
  }
  throw new Error("Timed out waiting for test child");
}
// Git hooks export GIT_* variables that would redirect fixture commands.
function withoutGitEnv(t) {
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")),
  );
  for (const name of Object.keys(saved)) delete process.env[name];
  t.after(() => Object.assign(process.env, saved));
}
function commitFixture(root, files = []) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (files.length) execFileSync("git", ["add", ...files], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=QA Fixture",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
}
async function listen(t, handler = (_, res) => res.end("local-worktree")) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return server.address().port;
}
async function closedPort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
const missing = (path) => assert.rejects(stat(path), { code: "ENOENT" });

/**
 * A clean committed checkout with a pinned executable, a completed frontend
 * build ID, loopback listeners and an injected target verifier.
 */
async function nativeFixture(t) {
  withoutGitEnv(t);
  const root = await temp(t);
  let frontendStatus = 200;
  let beforeFrontendReply;
  const port = await listen(t, async (_request, response) => {
    await beforeFrontendReply?.();
    response.writeHead(frontendStatus);
    response.end();
  });
  const c = config();
  c.frontend = c.backend.url = `http://127.0.0.1:${port}`;
  c.relay = `ws://127.0.0.1:${port}`;
  c.reuse = {
    frontend: "c".repeat(64),
    backend: "d".repeat(64),
    relay: "e".repeat(64),
    profile: "qa-synthetic",
  };
  const app = "#!/bin/sh\nexit 0\n";
  c.app.executable = ".artifacts/qa-app";
  c.app.sha256 = createHash("sha256").update(app).digest("hex");
  await mkdir(join(root, ".artifacts"));
  await writeFile(join(root, c.app.executable), app, { mode: 0o700 });
  await mkdir(join(root, ".next"));
  await writeFile(join(root, ".next/BUILD_ID"), "build-1");
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts/verify-local-dependencies.mjs"),
    await readFile("scripts/verify-local-dependencies.mjs"),
  );
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, ".gitignore"), ".artifacts/\n.next/\n");
  commitFixture(root, [".gitignore", "package.json", "scripts"]);
  const file = join(root, ".artifacts/config.json");
  const out = [];
  t.mock.method(console, "log", (line) => out.push(String(line)));
  const fx = {
    root,
    config: c,
    file,
    receipts: join(root, ".artifacts/desktop-qa/.receipts"),
    verifyCalls: 0,
    verifyError: undefined,
    setFrontendStatus: (status, beforeReply) => {
      frontendStatus = status;
      beforeFrontendReply = beforeReply;
    },
    save: (value = c) => writeFile(file, JSON.stringify(value)),
    async run(...args) {
      out.length = 0;
      const code = await main(args, root, {
        verify: async () => {
          fx.verifyCalls++;
          if (fx.verifyError) throw fx.verifyError;
          await fx.onVerify?.();
          return {};
        },
        verifyExecutable: async (checkout, appConfig) => {
          const executable = await verifyApp(checkout, appConfig);
          await fx.afterAppVerification?.();
          return executable;
        },
      });
      const text = out.join("\n");
      return {
        code,
        text,
        fingerprint: text.match(/^fingerprint: ([a-f0-9]{64})$/m)?.[1],
      };
    },
    preflight: (name = "chat-sandbox") =>
      fx.run("preflight", "native", file, name),
    recordResult: (outcome, fingerprint, name = "chat-sandbox") =>
      fx.run("record-result", file, name, outcome, fingerprint),
  };
  await fx.save();
  return fx;
}

test("rejects Production, mixed local targets, credentials and unknown fields", () => {
  assert.equal(validateConfig(config()).environment, "local");
  for (const mutate of [
    (c) => {
      c.environment = "production";
    },
    (c) => {
      c.frontend = "https://hackerai.co";
    },
    (c) => {
      c.backend.url = "https://other.convex.cloud";
    },
    (c) => {
      c.worker.environment = "production";
    },
    (c) => {
      c.relay = "wss://relay.hackerai.co";
    },
    (c) => {
      c.frontend = "http://user:password@127.0.0.1:3100";
    },
    (c) => {
      c.frontend += "/?token=test";
    },
    (c) => {
      c.frontend += "/secret";
    },
    (c) => {
      c.worker.secretKey = "DO_NOT_PRINT";
    },
    (c) => {
      c.app.executable = "../outside";
    },
  ]) {
    const c = config();
    mutate(c);
    assert.throws(() => validateConfig(c));
  }
});

// An immutable deployment URL loaded in the native WebView opens Vercel's
// deployment-protection login instead of the app.
const hostedDeployment = "https://hackerai-k3x9qv2mz-hackerai.vercel.app";
const localFrontendGuidance =
  /requires a loopback frontend.*serve this worktree's frontend locally.*Vercel Preview only for web-only browser QA/;

test("rejects hosted frontends for local and Preview native QA with local-frontend guidance", () => {
  for (const environment of ["local", "preview"])
    for (const frontend of [
      hostedDeployment,
      "https://hackerai-git-qa-branch-hackerai.vercel.app",
      "https://hackerai.co",
    ]) {
      const c = config();
      c.environment = environment;
      c.worker.environment =
        environment === "local" ? "development" : "preview";
      c.frontend = frontend;
      assert.throws(() => validateConfig(c), {
        message: localFrontendGuidance,
      });
    }
});

test("allows a local frontend with verified Preview services without relaxing worker selection", () => {
  const c = config();
  c.environment = "preview";
  c.worker.environment = "preview";
  c.backend.url = "https://example.convex.cloud";
  c.relay = "wss://preview-relay.example.test";
  assert.equal(validateConfig(c).frontend, "http://127.0.0.1:3100");
  for (const frontend of ["http://localhost:3100", "http://[::1]:3100"]) {
    c.frontend = frontend;
    assert.equal(validateConfig(c).frontend, frontend);
  }
  c.frontend = "http://127.0.0.1:3100";
  c.worker.environment = "production";
  assert.throws(() => validateConfig(c));
  c.worker.environment = "preview";
  c.frontend = "http://192.168.1.10:3100";
  assert.throws(() => validateConfig(c));
});

test("start rejects a hosted frontend before checking the app, probing services or creating a session", async (t) => {
  const root = await temp(t);
  const c = config();
  c.environment = "preview";
  c.worker.environment = "preview";
  c.frontend = hostedDeployment;
  c.backend.url = "https://example.convex.cloud";
  c.relay = "wss://preview-relay.example.test";
  // A valid executable that records its launch, so only validation stops it.
  const launched = join(root, "launched");
  const child = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(launched)}, "");\n`;
  await mkdir(join(root, "bin"));
  c.app.executable = "bin/qa-app.cjs";
  c.app.sha256 = createHash("sha256").update(child).digest("hex");
  await writeFile(join(root, c.app.executable), child, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify(c));
  const fetched = [];
  t.mock.method(globalThis, "fetch", (url) => {
    fetched.push(String(url));
    return Promise.reject(new Error("unexpected network access"));
  });
  await assert.rejects(
    main(["start", "hosted-frontend", join(root, "config.json")], root),
    { message: localFrontendGuidance },
  );
  assert.deepEqual(fetched, []);
  await assert.rejects(readFile(launched), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, ".artifacts")), { code: "ENOENT" });
});

test("serve rejects HTTPS before trying to launch its HTTP server", async (t) => {
  const dir = await temp(t);
  const c = config();
  c.environment = "preview";
  c.worker.environment = "preview";
  c.frontend = "https://127.0.0.1:3100";
  await writeFile(join(dir, "config.json"), JSON.stringify(c));
  await assert.rejects(
    main(["serve", "https-frontend", join(dir, "config.json")], dir),
    /serve requires an HTTP loopback frontend/,
  );
});

test("checks executable hash and rejects paths escaping the worktree through symlinks", async (t) => {
  const dir = await temp(t);
  const executable = join(dir, "app");
  const content = "#!/bin/sh\nexit 0\n";
  await writeFile(executable, content, { mode: 0o700 });
  const app = {
    executable: "app",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  assert.equal(await verifyApp(dir, app), await realpath(executable));
  await writeFile(executable, "changed");
  await assert.rejects(verifyApp(dir, app), /hash changed/);
  const outside = await temp(t);
  await writeFile(join(outside, "app"), content);
  await chmod(join(outside, "app"), 0o700);
  await symlink(join(outside, "app"), join(dir, "linked"));
  await assert.rejects(
    verifyApp(dir, { ...app, executable: "linked" }),
    /escapes/,
  );
});

test("health does not follow redirects, send cookies or read response content", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.method, "HEAD");
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(302, {
      Location: "https://hackerai.co/?secret=DO_NOT_PRINT",
    });
    res.end("DO_NOT_PRINT");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const c = config();
  c.frontend = `http://127.0.0.1:${server.address().port}`;
  c.backend.url = c.frontend;
  c.relay = c.frontend;
  const result = await health(c);
  assert.equal(result.frontend, "http-error-or-redirect");
  assert.equal(result.httpStatus, 302);
  assert.equal(result.backend, "tcp-reachable-not-authenticated");
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_PRINT"));
  c.frontend = "https://hackerai-example.vercel.app";
  c.backend.url = "https://example.convex.cloud";
  c.relay = "wss://example.invalid";
  assert.equal((await health(c)).frontend, "external-not-probed");
  assert.equal(requests, 1);
});

test(
  "stop terminates the owned process while preserving unrelated work and discarding raw output",
  { timeout: 15000 },
  async (t) => {
    const dir = await temp(t);
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    t.after(() => sentinel.kill());
    const running = supervise({
      command: process.execPath,
      args: [
        "-e",
        'console.log("DO_NOT_PRINT"); console.error("tr_dev_DO_NOT_PRINT"); setInterval(() => {}, 1000)',
      ],
      cwd: dir,
      dir,
    });
    const status = await waitFor(
      join(dir, "status.json"),
      (value) => value.state === "running",
    );
    await writeFile(join(dir, "stop.request"), "");
    assert.equal(await running, "stopped");
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
    assert.equal(
      JSON.parse(await readFile(join(dir, "status.json"), "utf8")).state,
      "stopped",
    );
    assert.ok(
      !(await readFile(join(dir, "events.jsonl"), "utf8")).includes(
        "DO_NOT_PRINT",
      ),
    );
  },
);

test(
  "escalates a child that ignores termination and records a failed spawn",
  { timeout: 15000 },
  async (t) => {
    const dir = await temp(t);
    const running = supervise({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); require("fs").writeFileSync("ready.json", "true"); setInterval(() => {}, 1000)',
      ],
      cwd: dir,
      dir,
    });
    await waitFor(join(dir, "ready.json"), Boolean);
    await writeFile(join(dir, "stop.request"), "");
    assert.equal(await running, "stopped");
    assert.equal(
      JSON.parse(await readFile(join(dir, "status.json"), "utf8")).signal,
      "SIGKILL",
    );
    const failed = join(dir, "failed");
    await mkdir(failed);
    assert.equal(
      await supervise({ command: join(dir, "missing"), cwd: dir, dir: failed }),
      "failed",
    );
  },
);

test("records only bounded run metadata with explicit observation provenance", async (t) => {
  const dir = await temp(t);
  await record(dir, "run_abc123", "completed", "desktop");
  const value = JSON.parse(
    (await readFile(join(dir, "observations.jsonl"), "utf8")).trim(),
  );
  assert.equal(value.source, "operator-observed");
  assert.equal(value.transport, "desktop");
  await assert.rejects(
    record(dir, "password=DO_NOT_PRINT", "completed", "desktop"),
  );
  await assert.rejects(record(dir, "run_ok", "user prompt", "desktop"));
  assert.ok(
    !(await readFile(join(dir, "observations.jsonl"), "utf8")).includes(
      "DO_NOT_PRINT",
    ),
  );
});

test(
  "stale stop requests never signal recorded PIDs or overwrite another session",
  { timeout: 12000 },
  async (t) => {
    const root = await temp(t);
    const dir = join(root, ".artifacts/desktop-qa/stale");
    await mkdir(dir, { recursive: true });
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    t.after(() => sentinel.kill());
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify({
        state: "running",
        pid: sentinel.pid,
        heartbeat: "2000-01-01T00:00:00Z",
      }),
    );
    await assert.rejects(main(["stop", "stale"], root), /not acknowledged/);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assert.rejects(main(["stop", "../stale"], root), /Invalid session/);
  },
);

for (const duringSpawn of [false, true])
  test(
    `terminal hangup ${duringSpawn ? "during startup" : "while running"} shuts down the owned child`,
    { timeout: 15000 },
    async (t) => {
      const dir = await temp(t);
      const runnerFile = join(dir, "supervisor.mjs");
      await writeFile(
        runnerFile,
        `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
if (${duringSpawn}) {
  const originalSpawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = originalSpawn(...args);
    writeFileSync('spawned.json', JSON.stringify({pid:child.pid}));
    process.kill(process.pid, 'SIGHUP');
    return child;
  };
  syncBuiltinESMExports();
}
const {supervise} = await import(${JSON.stringify(new URL("./qa.mjs", import.meta.url).href)});
await supervise({command:process.execPath,args:['-e','setInterval(() => {}, 1000)'],cwd:process.cwd(),dir:process.cwd()});`,
      );
      const supervisor = spawn(process.execPath, [runnerFile], {
        cwd: dir,
        stdio: "ignore",
      });
      const exited = new Promise((resolve, reject) => {
        supervisor.once("exit", (code, signal) => resolve({ code, signal }));
        supervisor.once("error", reject);
      });
      let childPid;
      t.after(() => {
        supervisor.kill("SIGTERM");
        if (childPid) {
          try {
            process.kill(childPid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      });
      const status = await waitFor(
        join(dir, duringSpawn ? "spawned.json" : "status.json"),
        (value) => duringSpawn || value.state === "running",
      );
      childPid = status.pid;
      if (!duringSpawn) supervisor.kill("SIGHUP");
      const outcome = await exited;
      assert.deepEqual(outcome, { code: 0, signal: null });
      assert.equal(
        JSON.parse(await readFile(join(dir, "status.json"), "utf8")).state,
        "stopped",
      );
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      childPid = undefined;
    },
  );

test("a synchronous spawn failure restores the callers signal listeners", async (t) => {
  const dir = await temp(t);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const before = signals.map((name) => process.listenerCount(name));
  await assert.rejects(supervise({ command: null, cwd: dir, dir }), {
    code: "ERR_INVALID_ARG_TYPE",
  });
  assert.deepEqual(
    signals.map((name) => process.listenerCount(name)),
    before,
  );
});

test("start verifies targets but never passes control-plane tokens to its child", async (t) => {
  withoutGitEnv(t);
  const root = await temp(t);
  const c = config();
  const server = createServer((req, res) => res.end("local-worktree"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  c.frontend = c.backend.url = `http://127.0.0.1:${server.address().port}`;
  c.relay = c.backend.url;
  await mkdir(join(root, ".convex/local/default"), { recursive: true });
  await writeFile(
    join(root, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "local-worktree",
      ports: { cloud: server.address().port },
    }),
  );
  await mkdir(join(root, ".artifacts"));
  const output = join(root, "child-flags.json");
  const child = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ convex: !!process.env.CONVEX_ACCESS_TOKEN, trigger: !!process.env.TRIGGER_ACCESS_TOKEN }));\n`;
  c.app.executable = ".artifacts/qa-app.cjs";
  c.app.sha256 = createHash("sha256").update(child).digest("hex");
  await writeFile(join(root, c.app.executable), child, { mode: 0o700 });
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts/verify-local-dependencies.mjs"),
    await readFile("scripts/verify-local-dependencies.mjs"),
  );
  await writeFile(join(root, "package.json"), "{}");
  commitFixture(root);
  await writeFile(join(root, "config.json"), JSON.stringify(c));
  const originalFetch = globalThis.fetch;
  const verifiedPaths = [];
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url).startsWith("https://api.trigger.dev/")) {
      verifiedPaths.push(new URL(url).pathname);
      assert.equal(
        init.headers.authorization,
        "Bearer synthetic-control-token",
      );
      return Promise.resolve(
        Response.json(
          String(url).endsWith("workers/current")
            ? { worker: { id: "test", version: "unverified" } }
            : { externalRef: "proj_example" },
        ),
      );
    }
    return originalFetch(url, init);
  });
  const oldConvex = process.env.CONVEX_ACCESS_TOKEN;
  const oldTrigger = process.env.TRIGGER_ACCESS_TOKEN;
  process.env.CONVEX_ACCESS_TOKEN = "synthetic-control-token";
  process.env.TRIGGER_ACCESS_TOKEN = "synthetic-control-token";
  t.after(() => {
    for (const [name, value] of [
      ["CONVEX_ACCESS_TOKEN", oldConvex],
      ["TRIGGER_ACCESS_TOKEN", oldTrigger],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await main(["start", "token-isolation", join(root, "config.json")], root);
  assert.deepEqual(verifiedPaths, [
    "/api/v1/projects/proj_example",
    "/api/v1/projects/proj_example/dev/workers/current",
  ]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    convex: false,
    trigger: false,
  });
});

test("preflight web and windows-vm give guidance without touching files, network or verification", async (t) => {
  const root = await temp(t);
  const fetched = [];
  t.mock.method(globalThis, "fetch", (url) => {
    fetched.push(String(url));
    return Promise.reject(new Error("unexpected network access"));
  });
  const out = [];
  t.mock.method(console, "log", (line) => out.push(String(line)));
  let verified = 0;
  const verify = async () => {
    verified++;
  };
  assert.equal(await main(["preflight", "web"], root, { verify }), 0);
  assert.match(out.join("\n"), /Vercel Preview/);
  assert.match(out.join("\n"), /never fall back to Production/);
  out.length = 0;
  assert.equal(await main(["preflight", "windows-vm"], root, { verify }), 0);
  const windows = out.join("\n");
  assert.match(windows, /running VM is not proof/);
  assert.match(windows, /never launches, pauses or signs in/);
  assert.match(windows, /inside the guest.*preflight native/);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(fetched, []);
  assert.equal(verified, 0);
});

test("native preflight stops at a local blocker before any target verification", async (t) => {
  const fx = await nativeFixture(t);
  const blockers = [
    [
      async () => writeFile(join(fx.root, fx.config.app.executable), "changed"),
      /hash changed/,
    ],
    [
      async () =>
        fx.save({
          ...fx.config,
          frontend: `http://127.0.0.1:${await closedPort()}`,
        }),
      /Local frontend is not ready/,
    ],
    [
      async () =>
        fx.save({
          ...fx.config,
          relay: `ws://127.0.0.1:${await closedPort()}`,
        }),
      /Loopback relay is not listening/,
    ],
  ];
  for (const [inject, reason] of blockers) {
    await fx.save();
    await writeFile(
      join(fx.root, fx.config.app.executable),
      "#!/bin/sh\nexit 0\n",
    );
    await inject();
    const result = await fx.preflight();
    assert.equal(result.code, 2);
    assert.match(result.text, /^preflight native chat-sandbox: BLOCKED$/m);
    assert.match(result.text, reason);
    assert.match(result.text, /no provider control plane was contacted/);
    assert.equal(result.fingerprint, undefined);
  }
  assert.equal(fx.verifyCalls, 0);
  await missing(join(fx.root, ".artifacts/desktop-qa"));
});

test("an operator PASS is reused only for the same case and exact identity", async (t) => {
  const fx = await nativeFixture(t);
  const first = await fx.preflight();
  assert.equal(first.code, 0);
  assert.match(first.text, /: READY$/m);
  assert.match(first.text, /prior result: none for this case/);
  assert.match(first.text, /window\/lock.*\n.*account.*\n.*transport/);
  assert.ok(first.fingerprint);
  assert.equal((await fx.recordResult("pass", first.fingerprint)).code, 0);
  const receipt = join(fx.receipts, "chat-sandbox.json");
  assert.equal((await stat(receipt)).mode & 0o777, 0o600);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(receipt, "utf8"))).sort(),
    ["case", "fingerprint", "outcome", "recordedAt", "source", "version"],
  );
  const again = await fx.preflight();
  assert.equal(again.fingerprint, first.fingerprint);
  assert.match(
    again.text,
    /prior result: PASS recorded .* for this exact identity/,
  );

  fx.setFrontendStatus(503);
  const offline = await fx.preflight();
  assert.equal(offline.code, 2);
  assert.match(
    offline.text,
    /historical PASS: .*live readiness remains unverified/,
  );
  assert.equal(offline.fingerprint, undefined);
  fx.setFrontendStatus(200);

  // Another case has its own identity and never inherits this PASS.
  const other = await fx.preflight("findings-download");
  assert.notEqual(other.fingerprint, first.fingerprint);
  assert.match(other.text, /prior result: none for this case/);
  await assert.rejects(
    fx.recordResult("pass", first.fingerprint, "findings-download"),
    /does not match/,
  );
  await missing(join(fx.receipts, "findings-download.json"));
  // Recording recomputes locally; only the three preflights verified targets.
  assert.equal(fx.verifyCalls, 3);
});

test("preflight withholds a saved pass if the executable changes during its checks", async (t) => {
  const fx = await nativeFixture(t);
  const executable = join(fx.root, fx.config.app.executable);
  const original = await readFile(executable);
  const { fingerprint } = await fx.preflight();
  await fx.recordResult("pass", fingerprint);
  const replaceApp = () => writeFile(executable, "different executable");

  fx.onVerify = replaceApp;
  const duringVerification = await fx.preflight();
  assert.equal(duringVerification.code, 2);
  assert.match(duringVerification.text, /executable hash changed/);
  assert.doesNotMatch(
    duringVerification.text,
    /fingerprint:|prior result: PASS/,
  );

  fx.onVerify = undefined;
  await writeFile(executable, original);
  fx.setFrontendStatus(503, replaceApp);
  const whileOffline = await fx.preflight();
  assert.equal(whileOffline.code, 2);
  assert.match(whileOffline.text, /executable hash changed/);
  assert.doesNotMatch(whileOffline.text, /historical PASS/);
  assert.equal(fx.verifyCalls, 2);
});

test("preflight withholds reuse when the frontend rebuilds during fingerprinting", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  await fx.recordResult("pass", fingerprint);
  fx.afterAppVerification = () =>
    writeFile(join(fx.root, ".next/BUILD_ID"), "build-2");

  const rebuilding = await fx.preflight();
  assert.equal(rebuilding.code, 2);
  assert.equal(rebuilding.fingerprint, undefined);
  assert.match(rebuilding.text, /frontend build changed during verification/);
  assert.doesNotMatch(rebuilding.text, /prior result: PASS/);

  fx.afterAppVerification = undefined;
  const settled = await fx.preflight();
  assert.notEqual(settled.fingerprint, fingerprint);
  assert.match(settled.text, /different identity/);

  await writeFile(join(fx.root, ".next/BUILD_ID"), "build-1");
  fx.afterAppVerification = () => writeFile(join(fx.root, "notes.txt"), "edit");
  const editing = await fx.preflight();
  assert.equal(editing.code, 2);
  assert.equal(editing.fingerprint, undefined);
  assert.match(editing.text, /source checkout changed during verification/);
  assert.doesNotMatch(editing.text, /prior result: PASS/);
});

test("a target verification failure blocks and hides a matching PASS", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  await fx.recordResult("pass", fingerprint);
  fx.verifyError = new TargetVerificationError(
    "Trigger worker version mismatch",
  );
  const result = await fx.preflight();
  assert.equal(result.code, 2);
  assert.match(result.text, /: BLOCKED$/m);
  assert.match(result.text, /worker version mismatch/);
  assert.doesNotMatch(result.text, /^(prior result|fingerprint):/m);
  fx.verifyError = new Error("synthetic-secret");
  const unexpected = await fx.preflight();
  assert.equal(unexpected.code, 2);
  assert.match(unexpected.text, /reason: Target verification failed$/m);
  assert.doesNotMatch(unexpected.text, /synthetic-secret/);
});

test("the latest FAIL or BLOCKED for a case invalidates its earlier PASS", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  for (const outcome of ["fail", "blocked"]) {
    await fx.recordResult("pass", fingerprint);
    assert.match((await fx.preflight()).text, /prior result: PASS/);
    await fx.recordResult(outcome, fingerprint);
    assert.match(
      (await fx.preflight()).text,
      new RegExp(
        `latest ${outcome.toUpperCase()} for this case; fresh run required`,
      ),
    );
  }
});

test("identity drift requires a fresh run and refuses the stale fingerprint", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  await fx.recordResult("pass", fingerprint);
  // Field order in the config file does not change the normalized identity.
  const reordered = Object.fromEntries(Object.entries(fx.config).reverse());
  await fx.save(reordered);
  assert.equal((await fx.preflight()).fingerprint, fingerprint);

  const drifts = [
    () => writeFile(join(fx.root, ".next/BUILD_ID"), "build-2"),
    () =>
      fx.save({
        ...fx.config,
        reuse: { ...fx.config.reuse, backend: "f".repeat(64) },
      }),
    () =>
      fx.save({
        ...fx.config,
        worker: { ...fx.config.worker, version: "next" },
      }),
  ];
  for (const drift of drifts) {
    await fx.save();
    await writeFile(join(fx.root, ".next/BUILD_ID"), "build-1");
    await drift();
    const result = await fx.preflight();
    assert.equal(result.code, 0);
    assert.notEqual(result.fingerprint, fingerprint);
    assert.match(
      result.text,
      /PASS for a different identity; fresh run required/,
    );
    await assert.rejects(
      fx.recordResult("pass", fingerprint),
      /does not match/,
    );
  }
  await fx.save();
  await writeFile(join(fx.root, ".next/BUILD_ID"), "build-1");
  assert.match((await fx.preflight()).text, /PASS recorded .* exact identity/);
});

test("dirty, unidentified or unbuilt checkouts never offer or record reuse", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  execFileSync("git", ["config", "status.showUntrackedFiles", "no"], {
    cwd: fx.root,
  });
  const cases = [
    [
      () => writeFile(join(fx.root, "notes.txt"), "uncommitted"),
      () => rm(join(fx.root, "notes.txt")),
      /source checkout has uncommitted changes/,
    ],
    [
      () => fx.save({ ...fx.config, reuse: undefined }),
      () => fx.save(),
      /config has no reuse identity/,
    ],
    [
      () => rm(join(fx.root, ".next/BUILD_ID")),
      () => writeFile(join(fx.root, ".next/BUILD_ID"), "build-1"),
      /\.next\/BUILD_ID missing/,
    ],
  ];
  for (const [change, restore, reason] of cases) {
    await change();
    const result = await fx.preflight();
    assert.equal(result.code, 0);
    assert.match(result.text, /: READY$/m);
    assert.equal(result.fingerprint, undefined);
    assert.match(result.text, reason);
    await assert.rejects(fx.recordResult("pass", fingerprint), reason);
    await restore();
  }
  await missing(fx.receipts);
});

test("receipts stay inside the worktree and never follow symlinks", async (t) => {
  const fx = await nativeFixture(t);
  const { fingerprint } = await fx.preflight();
  const outside = await temp(t);
  const forged = JSON.stringify({
    version: 1,
    source: "operator-observed",
    case: "chat-sandbox",
    outcome: "pass",
    fingerprint,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  await writeFile(join(outside, "chat-sandbox.json"), forged);
  await mkdir(join(fx.root, ".artifacts/desktop-qa"));
  await symlink(outside, fx.receipts);
  assert.match((await fx.preflight()).text, /unreadable receipt/);
  await assert.rejects(fx.recordResult("fail", fingerprint), /aliases/);
  assert.equal(
    await readFile(join(outside, "chat-sandbox.json"), "utf8"),
    forged,
  );

  // A symlinked receipt file is unreadable, and recording replaces the link
  // instead of writing through it.
  await rm(fx.receipts);
  await mkdir(fx.receipts);
  await symlink(
    join(outside, "chat-sandbox.json"),
    join(fx.receipts, "chat-sandbox.json"),
  );
  assert.match((await fx.preflight()).text, /unreadable receipt/);
  await fx.recordResult("fail", fingerprint);
  assert.equal(
    await readFile(join(outside, "chat-sandbox.json"), "utf8"),
    forged,
  );
  assert.match((await fx.preflight()).text, /latest FAIL/);
  assert.deepEqual(await readdir(fx.receipts), ["chat-sandbox.json"]);
});

test("reuse config accepts only SHA-256 revisions and a synthetic profile slug", () => {
  const reuse = {
    frontend: "c".repeat(64),
    backend: "d".repeat(64),
    relay: "e".repeat(64),
    profile: "qa-synthetic",
  };
  assert.deepEqual(validateConfig({ ...config(), reuse }).reuse, reuse);
  assert.equal(validateConfig(config()).reuse, undefined);
  for (const change of [
    { profile: "qa@example.com" },
    { profile: "sk-live-synthetic" },
    { profile: "QA Profile" },
    { frontend: "abc123" },
    { relay: "E".repeat(64) },
    { extra: "x" },
  ])
    assert.throws(() =>
      validateConfig({ ...config(), reuse: { ...reuse, ...change } }),
    );
});

/** Runs `doctor origin` with no app, launch record or service verification. */
async function originDoctor(t, options = {}) {
  const root = await temp(t);
  const plans = await temp(t);
  const file = join(plans, "plan.json");
  const out = [];
  t.mock.method(console, "log", (line) => out.push(String(line)));
  const fetched = [];
  t.mock.method(globalThis, "fetch", (url) => {
    fetched.push(String(url));
    return Promise.reject(new Error("unexpected network access"));
  });
  const fx = {
    root,
    fetched,
    verifyCalls: 0,
    async run(plan) {
      out.length = 0;
      await writeFile(file, JSON.stringify(plan));
      const code = await main(["doctor", "origin", file], root, {
        verify: async () => {
          fx.verifyCalls++;
        },
        ...options,
      });
      const text = out.join("\n");
      const statuses = Object.fromEntries(
        text
          .split("\n")
          .slice(0, 5)
          .map((line) => line.split(": ")),
      );
      return { code, text, statuses };
    },
  };
  return fx;
}
const failingServer = (code) => {
  const server = new EventEmitter();
  server.listen = () =>
    queueMicrotask(() =>
      server.emit("error", Object.assign(new Error("DO_NOT_PRINT"), { code })),
    );
  server.close = (done) => done();
  return server;
};

test("doctor origin requires exact callback and upload membership and touches no app or service", async (t) => {
  const fx = await originDoctor(t);
  const port = await closedPort();
  const frontend = `http://127.0.0.1:${port}`;
  const plan = {
    frontend,
    callbackPaths: ["/callback", "/desktop-callback"],
    developmentCallbackUrls: [
      `${frontend}/callback`,
      `${frontend}/desktop-callback`,
      "http://localhost:3000/DO_NOT_PRINT",
    ],
    developmentUploadOrigins: ["https://do-not-print.example.test", frontend],
  };
  const ready = await fx.run(plan);
  assert.equal(ready.code, 0);
  assert.deepEqual(ready.statuses, {
    "doctor origin": "READY",
    origin: frontend,
    port: "available",
    callback: "allowed",
    "upload-origin": "allowed",
  });
  assert.match(
    ready.text,
    /relative to the operator-verified.*\n.*point-in-time/,
  );
  assert.doesNotMatch(ready.text, /callback\/|DO_NOT_PRINT|do-not-print/i);

  // Scheme, host, port and path must each match exactly.
  for (const near of [
    `http://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    "http://127.0.0.1:1",
  ]) {
    const result = await fx.run({
      ...plan,
      developmentCallbackUrls: [`${near}/callback`, `${near}/desktop-callback`],
      developmentUploadOrigins: [near],
    });
    assert.equal(result.code, 2);
    assert.equal(result.statuses["doctor origin"], "BLOCKED");
    assert.equal(result.statuses.callback, "missing");
    assert.equal(result.statuses["upload-origin"], "rejected");
  }
  for (const path of ["/callback/", "/Callback", "/auth/callback"]) {
    const result = await fx.run({
      ...plan,
      developmentCallbackUrls: [
        `${frontend}${path}`,
        `${frontend}/desktop-callback`,
      ],
    });
    assert.equal(result.statuses.callback, "missing");
    assert.equal(result.statuses["upload-origin"], "allowed");
  }
  // A complete empty list is negative evidence; an omitted list is unknown.
  const empty = await fx.run({
    ...plan,
    developmentCallbackUrls: [],
    developmentUploadOrigins: [],
  });
  assert.equal(empty.statuses.callback, "missing");
  assert.equal(empty.statuses["upload-origin"], "rejected");
  const unknown = await fx.run({ frontend, callbackPaths: ["/callback"] });
  assert.equal(unknown.code, 2);
  assert.equal(unknown.statuses["doctor origin"], "UNVERIFIED");
  assert.equal(unknown.statuses.callback, "unverified");
  assert.equal(unknown.statuses["upload-origin"], "unverified");

  assert.equal(fx.verifyCalls, 0);
  assert.deepEqual(fx.fetched, []);
  assert.deepEqual(await readdir(fx.root), []);
});

test("doctor origin reports an occupied port without stopping its owner and keeps other bind errors unverified", async (t) => {
  const port = await listen(t);
  const frontend = `http://127.0.0.1:${port}`;
  const fx = await originDoctor(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const occupied = await fx.run({ frontend, callbackPaths: ["/callback"] });
    assert.equal(occupied.code, 2);
    assert.equal(occupied.statuses["doctor origin"], "BLOCKED");
    assert.equal(occupied.statuses.port, "occupied");
  }

  assert.equal(
    await probePort(frontend, () => failingServer("EADDRINUSE")),
    "occupied",
  );
  const denied = await originDoctor(t, {
    portProbe: (origin) => probePort(origin, () => failingServer("EACCES")),
  });
  const result = await denied.run({
    frontend,
    callbackPaths: ["/callback"],
    developmentCallbackUrls: [`${frontend}/callback`],
    developmentUploadOrigins: [frontend],
  });
  assert.equal(result.statuses.port, "unverified");
  assert.equal(result.statuses["doctor origin"], "UNVERIFIED");
  assert.doesNotMatch(result.text, /DO_NOT_PRINT|EACCES/);
});

test("doctor origin rejects credentials, hosted, inexact or unsafe plans before binding and without echoing input", async (t) => {
  let probes = 0;
  const fx = await originDoctor(t, {
    portProbe: async () => {
      probes++;
      return "available";
    },
  });
  const base = {
    frontend: "http://127.0.0.1:3100",
    callbackPaths: ["/callback"],
  };
  for (const change of [
    { frontend: "http://qa:DO_NOT_PRINT@127.0.0.1:3100" },
    { frontend: "http://127.0.0.1:3100/?token=DO_NOT_PRINT" },
    { frontend: "http://127.0.0.1:3100/DO_NOT_PRINT" },
    { frontend: "https://hackerai.co" },
    { frontend: "http://127.0.0.1:0" },
    { callbackPaths: [] },
    { callbackPaths: ["callback"] },
    { callbackPaths: ["/callback?code=DO_NOT_PRINT"] },
    { callbackPaths: ["/DO_NOT_PRINT/../callback"] },
    {
      developmentCallbackUrls: [
        "http://qa:DO_NOT_PRINT@127.0.0.1:3100/callback",
      ],
    },
    { developmentCallbackUrls: ["https://do-not-print.example.test/callback"] },
    { developmentCallbackUrls: ["http://LOCALHOST:3100/callback"] },
    { developmentCallbackUrls: "http://127.0.0.1:3100/callback" },
    { developmentUploadOrigins: ["http://127.0.0.1:3100/DO_NOT_PRINT"] },
    { developmentUploadOrigins: ["http://*:3100"] },
    { developmentUploadOrigins: Array(65).fill("http://127.0.0.1:3100") },
    { uploadToken: "DO_NOT_PRINT" },
  ])
    await assert.rejects(fx.run({ ...base, ...change }), (error) => {
      assert.doesNotMatch(error.message, /DO_NOT_PRINT|do-not-print/i);
      return true;
    });
  await assert.rejects(
    fx.run({
      ...base,
      developmentCallbackUrls: Array(64).fill(
        `${base.frontend}/${"a".repeat(1200)}`,
      ),
    }),
    /at most 64 KiB/,
  );
  assert.equal(probes, 0);
  await assert.rejects(
    main(["doctor", "origin"], fx.root),
    /Usage: desktop:qa doctor origin/,
  );
});
