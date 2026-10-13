import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  validateConfig,
  verifyApp,
  health,
  supervise,
  record,
  main,
} from "./qa.mjs";

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
  const c = config();
  c.environment = "preview";
  c.frontend = "https://hackerai-example.vercel.app";
  c.worker.environment = "preview";
  assert.equal(validateConfig(c).environment, "preview");
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

test(
  "terminal hangup shuts down the owned child and records completion",
  { timeout: 15000 },
  async (t) => {
    const dir = await temp(t);
    const runnerFile = join(dir, "supervisor.mjs");
    await writeFile(
      runnerFile,
      `import {supervise} from ${JSON.stringify(new URL("./qa.mjs", import.meta.url).href)};
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
      join(dir, "status.json"),
      (value) => value.state === "running",
    );
    childPid = status.pid;
    supervisor.kill("SIGHUP");
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
