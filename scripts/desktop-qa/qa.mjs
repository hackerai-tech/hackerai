#!/usr/bin/env node
// Developer-only orchestration. Never import this module into the application.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { connect } from "node:net";
import { hostname, loadavg, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
class QaError extends Error {}
function check(ok, message) {
  if (!ok) throw new QaError(message);
}
function keys(value, allowed) {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  check(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown configuration field",
  );
}
function label(value) {
  check(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._ /-]{0,119}$/.test(value),
    "Invalid identity label",
  );
  check(
    !/tr_(dev|prod|preview)_|sk[-_]|secret|password|token=/i.test(value),
    "Credentials are not identity labels",
  );
  return value;
}
function url(value, protocols = ["http:", "https:"]) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new QaError("Invalid service URL");
  }
  check(
    protocols.includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === "/",
    "Use a credential-free service origin, without path, query or fragment",
  );
  return parsed;
}
const loopback = (value) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
function sha(value, length) {
  check(
    typeof value === "string" &&
      new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    "Invalid commit or SHA-256",
  );
  return value;
}
export function validateConfig(input) {
  keys(input, ["environment", "frontend", "backend", "worker", "relay", "app"]);
  check(
    ["local", "preview"].includes(input.environment),
    "QA only supports local or Preview environments",
  );
  const frontend = url(input.frontend).origin;
  check(
    input.environment === "local"
      ? loopback(frontend)
      : new URL(frontend).protocol === "https:" &&
          new URL(frontend).hostname.endsWith(".vercel.app"),
    "Frontend does not match the selected QA environment",
  );
  keys(input.backend, ["account", "project", "deployment", "url"]);
  const backend = {
    account: label(input.backend.account),
    project: label(input.backend.project),
    deployment: label(input.backend.deployment),
    url: url(input.backend.url).origin,
  };
  check(
    input.environment !== "local" || loopback(backend.url),
    "Local QA requires a loopback backend",
  );
  keys(input.worker, ["project", "environment", "branch", "version"]);
  check(
    input.worker.environment ===
      (input.environment === "local" ? "development" : "preview"),
    "Worker environment mismatch",
  );
  const worker = {
    project: label(input.worker.project),
    environment: input.worker.environment,
    branch: label(input.worker.branch),
    version: label(input.worker.version),
  };
  const relay = url(input.relay, ["http:", "https:", "ws:", "wss:"]).origin;
  check(
    input.environment !== "local" || loopback(relay),
    "Local QA requires a loopback relay",
  );
  keys(input.app, ["executable", "sha256", "sourceCommit", "version"]);
  check(
    typeof input.app.executable === "string" &&
      !isAbsolute(input.app.executable) &&
      !input.app.executable.split(/[\\/]/).includes(".."),
    "App executable must be relative to this worktree",
  );
  return {
    environment: input.environment,
    frontend,
    backend,
    worker,
    relay,
    app: {
      executable: input.app.executable,
      sha256: sha(input.app.sha256, 64),
      sourceCommit: sha(input.app.sourceCommit, 40),
      version: label(input.app.version),
    },
  };
}
async function inside(root, path) {
  const target = await realpath(path);
  const rel = relative(await realpath(root), target);
  check(
    rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "Path escapes this worktree",
  );
  return target;
}
export async function verifyApp(root, app) {
  const executable = await inside(root, resolve(root, app.executable));
  check((await stat(executable)).isFile(), "Native executable is not a file");
  await access(executable, constants.X_OK);
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  check(
    digest === app.sha256,
    "Native executable hash changed; verify the build before updating configuration",
  );
  return executable;
}
async function tcpHealth(origin) {
  if (!loopback(origin)) return "external-not-probed";
  const target = new URL(origin);
  return new Promise((done) => {
    const socket = connect({
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: Number(
        target.port ||
          (["https:", "wss:"].includes(target.protocol) ? 443 : 80),
      ),
    });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(2000, () => finish("unreachable"));
    socket.once("error", () => finish("unreachable"));
    socket.once("connect", () => finish("tcp-reachable-not-authenticated"));
  });
}
export async function health(config) {
  // No cloud probing, cookies, response bodies, redirects or credentials.
  const services = {
    backend: await tcpHealth(config.backend.url),
    worker: "not-probed",
    relay: await tcpHealth(config.relay),
  };
  if (!loopback(config.frontend))
    return { frontend: "external-not-probed", ...services };
  try {
    const response = await fetch(config.frontend, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return {
      frontend: response.ok ? "reachable" : "http-error-or-redirect",
      httpStatus: response.status,
      ...services,
    };
  } catch {
    return { frontend: "unreachable", ...services };
  }
}
async function writeJson(path, data) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
async function sessionDir(root, session, create = false) {
  check(/^[a-z0-9][a-z0-9-]{0,47}$/.test(session), "Invalid session name");
  const base = join(root, ".artifacts", "desktop-qa");
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await inside(root, artifacts);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await inside(root, base);
  const dir = join(base, session);
  if (create) await mkdir(dir, { mode: 0o700 }); // Exclusive: never adopt another session.
  check(
    !(await lstat(dir)).isSymbolicLink(),
    "Session aliases are not allowed",
  );
  return inside(base, dir);
}

// The live supervisor owns the ChildProcess handle. Stop never signals a PID
// loaded from disk, so stale sessions cannot kill a reused or unrelated PID.
export async function supervise({
  command,
  args = [],
  cwd,
  dir,
  env = process.env,
}) {
  check(
    process.platform !== "win32",
    "The QA supervisor currently supports macOS and Linux only",
  );
  const events = join(dir, "events.jsonl");
  const emit = async (event, fields = {}) =>
    appendFile(
      events,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 },
    );
  await writeJson(join(dir, "status.json"), {
    state: "starting",
    heartbeat: new Date().toISOString(),
  });
  let stopping = false;
  const signal = () => {
    stopping = true;
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const removeSignalHandlers = () => {
    for (const name of signals) process.removeListener(name, signal);
  };
  // Install before spawn: an unhandled OS signal can terminate Node even
  // between synchronous JavaScript statements, leaving a detached child.
  for (const name of signals) process.on(name, signal);
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: "ignore" });
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
  let ended = false;
  let failed = false;
  const completion = new Promise((done) => {
    child.once("error", () => {
      failed = true;
      ended = true;
      done({ exitCode: null, signal: null });
    });
    child.once("exit", (exitCode, signal) => {
      ended = true;
      done({ exitCode, signal });
    });
  });
  const signalChild = (signal) => {
    if (ended) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  try {
    await emit("process-start", { pid: child.pid ?? null });
    while (!ended && !stopping) {
      await writeJson(join(dir, "status.json"), {
        state: "running",
        pid: child.pid,
        heartbeat: new Date().toISOString(),
      });
      try {
        await access(join(dir, "stop.request"));
        stopping = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!stopping) await Promise.race([completion, delay(1000)]);
    }
    if (stopping && !ended) {
      await emit("stop-requested");
      signalChild("SIGTERM");
      await Promise.race([completion, delay(3000)]);
      if (!ended) {
        signalChild("SIGKILL");
        await completion;
      }
    }
    const outcome = await completion;
    await emit("process-exit", { ...outcome, spawnFailed: failed });
    const state =
      failed || (!stopping && outcome.exitCode !== 0) ? "failed" : "stopped";
    await writeJson(join(dir, "status.json"), {
      state,
      ...outcome,
      stoppedAt: new Date().toISOString(),
    });
    return state;
  } finally {
    try {
      if (!ended) {
        signalChild("SIGTERM");
        await Promise.race([completion, delay(3000)]);
        if (!ended) {
          signalChild("SIGKILL");
          await completion;
        }
      }
    } finally {
      // Keep handlers installed through cleanup, including forced shutdown.
      removeSignalHandlers();
    }
  }
}
export async function record(dir, runId, runStatus, transport) {
  check(
    /^run_[a-zA-Z0-9]{1,80}$/.test(runId),
    "Expected a Trigger run ID, not user content",
  );
  check(
    [
      "starting",
      "running",
      "completed",
      "canceled",
      "failed",
      "unknown",
    ].includes(runStatus),
    "Invalid run status",
  );
  check(
    ["desktop", "local", "cloud", "unknown"].includes(transport),
    "Invalid sandbox transport",
  );
  await appendFile(
    join(dir, "observations.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), source: "operator-observed", runId, runStatus, transport })}\n`,
    { mode: 0o600 },
  );
}
export async function main(args, root = ROOT) {
  const [action, session, configFile, ...rest] = args;
  if (action === "help" || !action) {
    console.log(
      "desktop:qa doctor <config.json>\ndesktop:qa start <session> <config.json>\ndesktop:qa serve <session> <config.json>\ndesktop:qa status <session>\ndesktop:qa stop <session>\ndesktop:qa record <session> <run_id> <starting|running|completed|canceled|failed|unknown> <desktop|local|cloud|unknown>",
    );
    return;
  }
  if (["doctor", "start", "serve"].includes(action)) {
    const config = validateConfig(
      JSON.parse(
        await readFile(action === "doctor" ? session : configFile, "utf8"),
      ),
    );
    const executable = await verifyApp(root, config.app);
    const report = {
      capturedAt: new Date().toISOString(),
      host: hostname(),
      platform: platform(),
      load: loadavg(),
      checkout: root,
      checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      nativeExecutableSha256: config.app.sha256,
      declaredIdentity: config,
      identityCaveat:
        "Configured identities are operator supplied; verify the loaded native frontend and actual backend/worker/transport through Computer Use.",
      health: await health(config),
    };
    if (action === "doctor") {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (action === "start")
      check(
        report.health.frontend !== "unreachable" &&
          report.health.frontend !== "http-error-or-redirect",
        "Local frontend is not ready; finish startup before native acceptance",
      );
    const guard = spawn(
      process.execPath,
      [join(root, "scripts/verify-local-dependencies.mjs")],
      { cwd: root, stdio: "ignore" },
    );
    const valid = await new Promise((done) => {
      guard.on("exit", (code) => done(code === 0));
      guard.on("error", () => done(false));
    });
    check(
      valid,
      "Dependency guard failed; run pnpm check:local-dependencies in this worktree",
    );
    let command = executable;
    let commandArgs = [];
    if (action === "serve") {
      check(
        config.environment === "local",
        "serve only starts a prebuilt local frontend",
      );
      const buildId = await readFile(join(root, ".next/BUILD_ID"), "utf8");
      report.frontendBuildIdSha256 = createHash("sha256")
        .update(buildId)
        .digest("hex");
      command = process.execPath;
      commandArgs = [
        join(root, "node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        new URL(config.frontend).hostname.replace(/^\[|\]$/g, ""),
        "--port",
        new URL(config.frontend).port || "80",
      ];
    }
    report.role = action === "serve" ? "frontend" : "desktop";
    const dir = await sessionDir(root, session, true);
    await writeJson(join(dir, "identity.json"), report);
    console.log(
      `QA session: ${session}. Diagnostics: .artifacts/desktop-qa/${session}`,
    );
    const state = await supervise({
      command,
      args: commandArgs,
      cwd: root,
      dir,
    });
    check(
      state !== "failed",
      "QA process failed; inspect the session lifecycle diagnostics",
    );
    return;
  }
  check(["status", "stop", "record"].includes(action), "Unknown QA command");
  const dir = await sessionDir(root, session);
  if (action === "record") {
    await record(dir, configFile, rest[0], rest[1]);
    return;
  }
  if (action === "stop") {
    await writeFile(join(dir, "stop.request"), "", { mode: 0o600 });
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const status = JSON.parse(
          await readFile(join(dir, "status.json"), "utf8"),
        );
        if (["stopped", "failed"].includes(status.state)) {
          console.log(JSON.stringify(status));
          return;
        }
      } catch {
        /* A concurrent status write may be incomplete. */
      }
      await delay(500);
    }
    throw new QaError(
      "Stop not acknowledged. Supervisor may be absent; no PID was signaled. Inspect task-owned processes manually.",
    );
  }
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  if (
    ["starting", "running"].includes(status.state) &&
    Date.now() - Date.parse(status.heartbeat) > 5000
  )
    status.state = "stale-unknown";
  console.log(
    JSON.stringify(
      {
        ...status,
        identity: JSON.parse(
          await readFile(join(dir, "identity.json"), "utf8"),
        ),
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    // Do not echo filesystem/network/JSON parse errors: they can contain input values.
    console.error(
      error instanceof QaError
        ? error.message
        : "Desktop QA command failed. Check the documented schema, build hash, dependency guard, frontend readiness and session status. No credentials or raw child logs were collected.",
    );
    process.exitCode = 1;
  });
}
