/**
 * Controlled CLI benchmark, using the product's real session manager.
 * Prerequisite: a disposable Linux Docker container with Chromium, Python 3,
 * Node and agent-browser@0.26.0. No application credentials/config required.
 * Usage: pnpm exec tsx scripts/benchmark-browser-workflows.mts <container>
 * The fixture listens on 4173 inside that container; publish it only on loopback
 * if you want to inspect it with the built-in Browser. Remove the container after.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { BrowserSessions } from "../lib/ai/tools/utils/browser-sessions";
import { browserSessionCommand } from "../lib/ai/tools/utils/browser-session-program";
import type { AnySandbox } from "../types";

const container = process.argv[2];
if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container)) {
  throw new Error("Pass the disposable benchmark container name.");
}
const docker = process.env.BROWSER_BENCHMARK_DOCKER ?? "docker";
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const base = "http://127.0.0.1:4173";
const checks: Array<{ check: string; passed: true }> = [];
const record = (check: string) => {
  checks.push({ check, passed: true });
  console.log(JSON.stringify({ check, passed: true }));
};

async function shell(command: string, env: Record<string, string> = {}) {
  try {
    const { stdout } = await exec(
      docker,
      [
        "exec",
        ...Object.keys(env).flatMap((key) => ["-e", key]),
        container,
        "bash",
        "-c",
        `umask 077; ${command}`,
      ],
      {
        env: { ...process.env, ...env },
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout;
  } catch {
    // Never print execFile errors: a command's output can contain auth state.
    throw new Error(
      "Benchmark command failed; inspect the disposable fixture manually.",
    );
  }
}
const sandbox = {
  sandboxId: container,
  commands: {
    run: async (command: string) => ({
      stdout: await shell(command),
      exitCode: 0,
    }),
  },
} as unknown as AnySandbox;
const owner = new BrowserSessions();
const other = new BrowserSessions();
let expiryDirectory: string | undefined;
try {
  await exec(docker, [
    "cp",
    fileURLToPath(
      new URL("./fixtures/browser-pentest-server.mjs", import.meta.url),
    ),
    `${container}:/tmp/browser-pentest-server.mjs`,
  ]);
  await exec(docker, [
    "exec",
    "-d",
    container,
    "node",
    "/tmp/browser-pentest-server.mjs",
  ]);
  const env = {
    ...(await owner.prepare(sandbox)),
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    AGENT_BROWSER_ARGS: "--no-sandbox,--disable-dev-shm-usage",
  };
  const otherEnv = { ...env, ...(await other.prepare(sandbox)) };
  const browser = async (args: string[], environment = env) => {
    const stdout = await shell(
      `agent-browser --json ${args.map(quote).join(" ")}`,
      environment,
    );
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, "Browser action must succeed");
    return result.data;
  };
  const command = (session: string, ...args: string[]) =>
    browser(["--session", session, ...args]);
  const text = async (session: string) =>
    JSON.stringify(await command(session, "get", "text", "h1"));
  const login = async (session: string) => {
    await command(session, "open", `${base}/login`);
    await command(session, "snapshot", "-i");
    await command(session, "find", "label", "Test identity", "fill", session);
    await command(
      session,
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Sign in",
    );
    await command(session, "wait", "--url", `${base}/account`);
    assert.match(await text(session), new RegExp(session));
  };
  await login("alice");
  record("login and identity verification");
  await login("bob");
  await command("alice", "open", `${base}/documents/alice`);
  assert.match(await text("alice"), /Alice document/);
  await command("bob", "open", `${base}/documents/alice`);
  assert.match(await text("bob"), /Forbidden/);
  record("two-account access control without cookie crossover");
  await browser(["--session", "alice", "open", `${base}/account`], otherEnv);
  assert.match(
    JSON.stringify(
      await browser(["--session", "alice", "get", "text", "h1"], otherEnv),
    ),
    /Anonymous/,
  );
  record("same session name isolated between agents/runs");
  await command("alice", "open", `${base}/spa`);
  await command(
    "alice",
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Continue",
  );
  await command("alice", "wait", "--url", `${base}/spa/done`);
  await command("alice", "wait", "--text", "SPA complete");
  record("SPA navigation with observed readiness");
  await command("alice", "open", `${base}/frame`);
  await command("alice", "frame", "#test-frame");
  const frame = await command("alice", "snapshot", "-i");
  const ref = (name: string) => {
    const entry = Object.entries(frame.refs).find(
      ([, value]) => (value as { name: string }).name === name,
    );
    assert.ok(entry, `Expected frame element: ${name}`);
    return `@${entry[0]}`;
  };
  await command("alice", "fill", ref("Frame value"), "Frame complete");
  await command("alice", "click", ref("Apply"));
  const updatedFrame = await command("alice", "snapshot", "-i");
  assert.match(updatedFrame.snapshot, /heading "Frame complete"/);
  await command("alice", "frame", "main");
  record("iframe interaction");
  const checkpoint = `${env.HACKERAI_BROWSER_STATE_DIR}/alice.json`;
  await command("alice", "state", "save", checkpoint);
  await shell(
    `test ! -e ${quote(checkpoint)} && test -f ${quote(checkpoint + ".enc")} && test "$(stat -c %a ${quote(checkpoint + ".enc")})" = 600`,
  );
  await command("alice", "close");
  await command("alice", "state", "load", checkpoint + ".enc");
  await command("alice", "open", `${base}/account`);
  assert.match(await text("alice"), /alice/);
  record("encrypted checkpoint and authenticated restart recovery");
  let rejected = false;
  try {
    await browser(
      ["--session", "alice", "state", "load", checkpoint + ".enc"],
      otherEnv,
    );
  } catch {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    "Another run's key must not decrypt this checkpoint",
  );
  record("cross-run checkpoint decryption rejected");
  await owner.cleanup();
  await shell(`test ! -e ${quote(env.HACKERAI_BROWSER_STATE_DIR)}`);
  assert.match(
    JSON.stringify(
      await browser(["--session", "alice", "get", "text", "h1"], otherEnv),
    ),
    /Anonymous/,
  );
  await assert.rejects(() => owner.prepare(sandbox), /ownership has ended/);
  record("cleanup erases checkpoints and preserves other agents");
  expiryDirectory = `/dev/shm/hackerai-browser-${randomBytes(12).toString("hex")}`;
  await shell(
    browserSessionCommand("prepare", expiryDirectory, Date.now() + 1500),
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await shell(`test ! -e ${quote(expiryDirectory)}`);
  record("independent expiry after missing worker cleanup");
  console.log(
    JSON.stringify({ browser: "agent-browser@0.26.0", checks }, null, 2),
  );
} finally {
  await Promise.all([owner.cleanup(), other.cleanup()]);
  if (expiryDirectory)
    await shell(
      browserSessionCommand("cleanup", expiryDirectory, Date.now()),
    ).catch(() => undefined);
}
