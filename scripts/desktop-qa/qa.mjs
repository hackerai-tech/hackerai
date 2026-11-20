#!/usr/bin/env node
// Developer-only orchestration. Never import this module into the application.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { connect } from "node:net";
import { arch, hostname, loadavg, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyTargets, TargetVerificationError } from "./verify-targets.mjs";

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
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
function caseName(value) {
  check(
    typeof value === "string" && SLUG.test(value),
    "Invalid case name; use lowercase letters, digits and hyphens",
  );
  return value;
}
// Optional exact-reuse identity: SHA-256 revision fingerprints copied from
// verified local build/run records, plus a synthetic QA profile slug.
function reuseIdentity(input) {
  keys(input, ["frontend", "backend", "relay", "profile"]);
  check(
    typeof input.profile === "string" && SLUG.test(input.profile),
    "QA profile must be a short synthetic label, never an email or credential",
  );
  return {
    frontend: sha(input.frontend, 64),
    backend: sha(input.backend, 64),
    relay: sha(input.relay, 64),
    profile: label(input.profile),
  };
}
export function validateConfig(input) {
  keys(input, [
    "environment",
    "frontend",
    "backend",
    "worker",
    "relay",
    "app",
    "reuse",
  ]);
  check(
    ["local", "preview"].includes(input.environment),
    "QA only supports local or Preview environments",
  );
  const frontend = url(input.frontend).origin;
  // Hosted deployments (including Vercel Preview) can show deployment protection
  // inside the native WebView, so native QA always loads a local frontend.
  check(
    loopback(frontend),
    "Native QA requires a loopback frontend (localhost, 127.0.0.1 or [::1]). Build and serve this worktree's frontend locally, pointed at the verified backend/worker/relay; use hosted Vercel Preview only for web-only browser QA.",
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
    ...(input.reuse !== undefined && { reuse: reuseIdentity(input.reuse) }),
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
async function artifactsBase(root) {
  const base = join(root, ".artifacts", "desktop-qa");
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await inside(root, artifacts);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await inside(root, base);
  return base;
}
async function sessionDir(root, session, create = false) {
  check(SLUG.test(session), "Invalid session name");
  const base = await artifactsBase(root);
  const dir = join(base, session);
  if (create) await mkdir(dir, { mode: 0o700 }); // Exclusive: never adopt another session.
  check(
    !(await lstat(dir)).isSymbolicLink(),
    "Session aliases are not allowed",
  );
  return inside(base, dir);
}
async function dependencyGuard(root) {
  const guard = spawn(
    process.execPath,
    [join(root, "scripts/verify-local-dependencies.mjs")],
    { cwd: root, stdio: "ignore" },
  );
  return new Promise((done) => {
    guard.on("exit", (code) => done(code === 0));
    guard.on("error", () => done(false));
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
/**
 * Local-only receipt key for one case. Callers verify the executable hash first.
 * Returns { fingerprint } or { unavailable: reason }; never contacts a provider.
 */
async function receiptIdentity(root, config, name) {
  if (!config.reuse) return { unavailable: "config has no reuse identity" };
  let checkoutCommit;
  try {
    checkoutCommit = git(root, ["rev-parse", "HEAD"]).trim();
    check(/^[a-f0-9]{40,64}$/.test(checkoutCommit), "Unknown commit");
    if (
      git(root, [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ]).length > 0
    )
      return { unavailable: "source checkout has uncommitted changes" };
  } catch {
    return { unavailable: "source commit unknown" };
  }
  let buildId;
  try {
    const file = await inside(root, join(root, ".next", "BUILD_ID"));
    const info = await stat(file);
    check(info.isFile() && info.size > 0 && info.size <= 4096, "Bad build");
    buildId = await readFile(file);
  } catch {
    return { unavailable: "frontend .next/BUILD_ID missing" };
  }
  // validateConfig fixes key order, so this serialization is canonical.
  const identity = {
    version: 1,
    case: name,
    config,
    executableSha256: config.app.sha256,
    checkoutCommit,
    host: {
      name: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
    },
    frontendBuildIdSha256: sha256(buildId),
    revisions: config.reuse,
  };
  return { fingerprint: sha256(JSON.stringify(identity)) };
}

const OUTCOMES = ["pass", "fail", "blocked"];
// `.receipts` cannot collide with a session name, which must start with [a-z0-9].
async function receiptFile(root, name, create) {
  const base = create
    ? await artifactsBase(root)
    : await inside(root, join(root, ".artifacts", "desktop-qa"));
  const dir = join(base, ".receipts");
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  check(
    !(await lstat(dir)).isSymbolicLink(),
    "Receipt store aliases are not allowed",
  );
  return join(await inside(base, dir), `${name}.json`);
}
/** Latest operator-observed outcome for one case, null if none, or { invalid }. */
async function readReceipt(root, name) {
  let file;
  try {
    const path = await receiptFile(root, name, false);
    // A pre-open check also rejects aliases on Windows, where O_NOFOLLOW
    // may be unavailable. O_NONBLOCK bounds a replaced FIFO on Unix.
    if (!(await lstat(path)).isFile()) return { invalid: true };
    file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return error.code === "ENOENT" ? null : { invalid: true };
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) return { invalid: true };
    const value = JSON.parse(await file.readFile("utf8"));
    const valid =
      value.version === 1 &&
      value.source === "operator-observed" &&
      value.case === name &&
      OUTCOMES.includes(value.outcome) &&
      /^[a-f0-9]{64}$/.test(value.fingerprint) &&
      /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.recordedAt);
    return valid ? value : { invalid: true };
  } catch {
    return { invalid: true };
  } finally {
    await file.close();
  }
}
async function writeReceipt(root, name, receipt) {
  const path = await receiptFile(root, name, true);
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  // Exclusive create: never write through an existing file or symlink.
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`);
    await file.close();
    await rename(temp, path);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
}
function priorResult(identity, receipt) {
  if (!identity.fingerprint)
    return [`reuse: unavailable (${identity.unavailable}); run the case`];
  const lines = [`fingerprint: ${identity.fingerprint}`];
  if (!receipt)
    lines.push("prior result: none for this case; run it, then record-result");
  else if (receipt.invalid)
    lines.push("prior result: unreadable receipt; run the case");
  else if (receipt.outcome !== "pass")
    lines.push(
      `prior result: latest ${receipt.outcome.toUpperCase()} for this case; fresh run required`,
    );
  else if (receipt.fingerprint !== identity.fingerprint)
    lines.push(
      "prior result: PASS for a different identity; fresh run required",
    );
  else
    lines.push(
      `prior result: PASS recorded ${receipt.recordedAt} for this exact identity (operator-observed); reusable unless the case needs fresh evidence`,
    );
  return lines;
}

const OPERATOR_CHECKS = [
  "operator checks (not inferred):",
  "- window/lock: host unlocked; the exact QA app window, not the installed app, is visible to Computer Use",
  "- account: confirm the signed-in account in the native user menu; listeners and browser logins do not prove WebView or relay auth",
  "- transport: one harmless Agent command shows the worker run and Desktop sandbox transport",
  "- gates: collect a new observation whenever the check requires fresh evidence",
];
const WEB_GUIDANCE = [
  "preflight web: use the branch's Vercel Preview in a browser. Nothing local was checked or started.",
  "- push the branch, wait for its Preview deployment and confirm the deployed commit",
  "- verify the designated Preview backend and Trigger worker, then complete one harmless Agent request with the Preview test account and confirm it survives reload",
  "- never fall back to Production; native commands, Desktop transport and Save dialogs need preflight native",
];
const WINDOWS_GUIDANCE = [
  "preflight windows-vm: manual. The host checked nothing; a running VM is not proof it is available to you.",
  "- ownership: confirm this task owns the VM session and no other task is using it; this command never launches, pauses or signs in",
  "- sign-in: confirm the guest's signed-in user yourself; record guest architecture and whether the executable is emulated",
  "- guest-local checks: inside the guest's own worktree run `corepack pnpm desktop:qa preflight native <config.json> <case>`",
  "- required Windows CI and native acceptance remain separate gates",
];

async function preflightNative(root, config, name, verify) {
  const report = (state, lines) => {
    console.log(
      [`preflight native ${name}: ${state}`, ...lines, ...OPERATOR_CHECKS].join(
        "\n",
      ),
    );
    return state === "READY" ? 0 : 2;
  };
  const local = (reason, extra = []) =>
    report("BLOCKED", [
      `reason: ${reason}`,
      ...extra,
      "no provider control plane was contacted; fix this and rerun",
    ]);
  // Hard local readiness first, so a local blocker never triggers remote reads.
  try {
    await verifyApp(root, config.app);
  } catch (error) {
    return local(
      error instanceof QaError
        ? error.message
        : "Native executable is missing or not executable",
    );
  }
  if (!(await dependencyGuard(root)))
    return local(
      "Dependency guard failed; run pnpm check:local-dependencies in this worktree",
    );
  const services = await health(config);
  const healthLine = `health: frontend=${services.frontend} backend=${services.backend} relay=${services.relay} worker=${services.worker}`;
  const offlineService = ["backend", "relay"].find(
    (service) => services[service] === "unreachable",
  );
  const localBlocker =
    services.frontend !== "reachable"
      ? "Local frontend is not ready (unreachable, HTTP error or redirect)"
      : offlineService && `Loopback ${offlineService} is not listening`;
  if (localBlocker) {
    const identity = await receiptIdentity(root, config, name);
    const receipt = identity.fingerprint && (await readReceipt(root, name));
    const details = [healthLine];
    if (
      receipt?.outcome === "pass" &&
      receipt.fingerprint === identity.fingerprint
    )
      details.push(
        `historical PASS: ${receipt.recordedAt} for the same recorded inputs; live readiness remains unverified`,
      );
    return local(localBlocker, details);
  }
  try {
    await verify(config, { root });
  } catch (error) {
    return report("BLOCKED", [
      `reason: ${error instanceof TargetVerificationError ? error.message : "Target verification failed"}`,
      healthLine,
      "targets did not verify; prior results are not shown",
    ]);
  }
  const identity = await receiptIdentity(root, config, name);
  return report("READY", [
    healthLine,
    "targets: backend and worker verified (read-only)",
    ...priorResult(
      identity,
      identity.fingerprint ? await readReceipt(root, name) : null,
    ),
  ]);
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
const readConfig = async (file) =>
  validateConfig(JSON.parse(await readFile(file, "utf8")));
/**
 * Returns a process exit code: preflight native returns 2 when BLOCKED.
 * Invalid input and other command failures throw (exit 1 from the CLI).
 * `verify` is injectable for tests; production uses the live target verifier.
 */
export async function main(args, root = ROOT, { verify = verifyTargets } = {}) {
  const [action, session, configFile, ...rest] = args;
  if (action === "help" || !action) {
    console.log(
      "desktop:qa preflight web\ndesktop:qa preflight windows-vm\ndesktop:qa preflight native <config.json> <case>\ndesktop:qa record-result <config.json> <case> <pass|fail|blocked> <fingerprint>\ndesktop:qa verify <config.json>\ndesktop:qa doctor <config.json>\ndesktop:qa start <session> <config.json>\ndesktop:qa serve <session> <config.json>\ndesktop:qa status <session>\ndesktop:qa stop <session>\ndesktop:qa record <session> <run_id> <starting|running|completed|canceled|failed|unknown> <desktop|local|cloud|unknown>",
    );
    return 0;
  }
  if (action === "preflight") {
    // Guidance targets read no files and make no network or process calls.
    if (session === "web") {
      console.log(WEB_GUIDANCE.join("\n"));
      return 0;
    }
    if (session === "windows-vm") {
      console.log(WINDOWS_GUIDANCE.join("\n"));
      return 0;
    }
    check(
      session === "native" && rest.length <= 1,
      "Usage: desktop:qa preflight <web|windows-vm|native <config.json> <case>>",
    );
    const name = caseName(rest[0]);
    return preflightNative(root, await readConfig(configFile), name, verify);
  }
  if (action === "record-result") {
    const [, file, rawCase, outcome, fingerprint] = args;
    const name = caseName(rawCase);
    check(OUTCOMES.includes(outcome), "Outcome must be pass, fail or blocked");
    check(
      typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
      "Expected the 64-character fingerprint printed by preflight native",
    );
    const config = await readConfig(file);
    // Recompute locally; recording never repeats provider reads.
    await verifyApp(root, config.app);
    const identity = await receiptIdentity(root, config, name);
    check(
      identity.fingerprint,
      `Result reuse is unavailable (${identity.unavailable}); nothing was recorded`,
    );
    check(
      identity.fingerprint === fingerprint,
      "Fingerprint does not match this case and current local identity; rerun preflight native. Nothing was recorded",
    );
    await writeReceipt(root, name, {
      version: 1,
      source: "operator-observed",
      case: name,
      outcome,
      fingerprint,
      recordedAt: new Date().toISOString(),
    });
    console.log(
      `Recorded operator-observed ${outcome.toUpperCase()} for case ${name}.`,
    );
    return 0;
  }
  if (["verify", "doctor", "start", "serve"].includes(action)) {
    const config = validateConfig(
      JSON.parse(
        await readFile(
          ["verify", "doctor"].includes(action) ? session : configFile,
          "utf8",
        ),
      ),
    );
    if (action === "verify") {
      console.log(JSON.stringify(await verify(config, { root }), null, 2));
      return;
    }
    if (action === "serve")
      check(
        loopback(config.frontend) &&
          new URL(config.frontend).protocol === "http:",
        "serve requires an HTTP loopback frontend",
      );
    const executable = await verifyApp(root, config.app);
    const verifiedTargets = await verify(config, { root });
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
      verifiedTargets,
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
    check(
      await dependencyGuard(root),
      "Dependency guard failed; run pnpm check:local-dependencies in this worktree",
    );
    let command = executable;
    let commandArgs = [];
    if (action === "serve") {
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
    const childEnv = { ...process.env };
    delete childEnv.CONVEX_ACCESS_TOKEN;
    delete childEnv.TRIGGER_ACCESS_TOKEN;
    const state = await supervise({
      command,
      args: commandArgs,
      cwd: root,
      dir,
      env: childEnv,
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
  main(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === "number") process.exitCode = code;
    },
    (error) => {
      // Do not echo filesystem/network/JSON parse errors: they can contain input values.
      console.error(
        error instanceof QaError || error instanceof TargetVerificationError
          ? error.message
          : "Desktop QA command failed. Check the documented schema, build hash, dependency guard, frontend readiness and session status. No credentials or raw child logs were collected.",
      );
      process.exitCode = 1;
    },
  );
}
