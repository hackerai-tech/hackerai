import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { browserSessionCommand } from "../browser-session-program";
import {
  BROWSER_DAEMON_PROGRAM,
  BROWSER_DAEMON_SESSION_CLOSED,
} from "../../../browser-handoff/daemon-program";

// Also exported for a dependency-free Linux run of this same committed fixture.
export function verifyBrowserResumeTargets() {
  const root = mkdtempSync("/dev/shm/hackerai-browser-verification-");
  rmSync(root, { recursive: true });
  const bin = mkdtempSync("/tmp/hackerai-verification-cli-");
  const ledger = `${bin}/calls`;
  writeFileSync(
    `${bin}/agent-browser`,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGENT_BROWSER_SESSION: "default",
    AGENT_BROWSER_SOCKET_DIR: `${root}/sockets`,
    AGENT_BROWSER_CONFIG: `${root}/config.json`,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "900000",
  };
  const lifecycle = (action: "prepare" | "resume" | "cleanup") => {
    const result = spawnSync(
      browserSessionCommand(action, root, Date.now() + 60_000, true),
      { shell: true, env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const run = (
    args: string[],
    overrides: Record<string, string | undefined> = {},
  ) =>
    spawnSync(`${root.replace("/dev/shm/", "/tmp/")}/bin/agent-browser`, args, {
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 5000,
    });
  let rejected = 0;
  try {
    lifecycle("prepare");
    assert.equal(run(["--session", "kept", "snapshot", "-i"]).status, 0);
    lifecycle("resume");
    assert.equal(existsSync(`${root}/verify-required`), true);
    for (const options of [
      ["--cdp", "http://127.0.0.1:6553"],
      ["--cdp=http://127.0.0.1:6553"],
      ["--auto-connect"],
      ["--provider", "other"],
      ["--provider=other"],
      ["-p", "other"],
      ["--profile", "/tmp/other-profile"],
      ["--profile=/tmp/other-profile"],
      ["--namespace", "other"],
      ["--namespace=other"],
      ["--config", "/tmp/other-config.json"],
      ["--config=/tmp/other-config.json"],
      ["--debug"],
      ["--idle-timeout", "1s"],
      ["--action-policy", "/tmp/other-policy.json"],
      ["--engine", "lightpanda"],
    ]) {
      for (const args of [
        [...options, "snapshot", "-i"],
        ["snapshot", "-i", ...options],
      ]) {
        writeFileSync(ledger, "");
        assert.equal(run(args).status, 75, JSON.stringify(args));
        assert.equal(existsSync(`${root}/verify-required`), true);
        assert.equal(readFileSync(ledger, "utf8"), "");
        rejected++;
      }
    }
    for (const overrides of [
      { AGENT_BROWSER_NAMESPACE: "other" },
      { AGENT_BROWSER_SOCKET_DIR: "/tmp/other-sockets" },
      { AGENT_BROWSER_CONFIG: "/tmp/other-config.json" },
      { AGENT_BROWSER_SOCKET_DIR: undefined },
      { AGENT_BROWSER_CONFIG: undefined },
      { AGENT_BROWSER_CDP: "9222" },
      { AGENT_BROWSER_AUTO_CONNECT: "1" },
      { AGENT_BROWSER_PROVIDER: "other" },
      { AGENT_BROWSER_PROFILE: "/tmp/other-profile" },
      { AGENT_BROWSER_ENGINE: "lightpanda" },
      { AGENT_BROWSER_ARGS: "--other-launch-arg" },
      { AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000" },
      { AGENT_BROWSER_IDLE_TIMEOUT_MS: undefined },
      { AGENT_BROWSER_ACTION_POLICY: "/tmp/other-policy.json" },
    ]) {
      writeFileSync(ledger, "");
      assert.equal(run(["snapshot", "-i"], overrides).status, 75);
      assert.equal(existsSync(`${root}/verify-required`), true);
      assert.equal(readFileSync(ledger, "utf8"), "");
      rejected++;
    }
    assert.notEqual(run(["--session", "other", "snapshot", "-i"]).status, 0);
    assert.equal(existsSync(`${root}/verify-required`), true);
    assert.equal(
      run(["--json", "snapshot", "-i", "--compact"], {
        AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
      }).status,
      0,
    );
    assert.equal(existsSync(`${root}/verify-required`), false);
    assert.equal(readFileSync(`${root}/active-session`, "utf8"), "kept");
    // Once the original browser has been inspected, ordinary options work again.
    writeFileSync(ledger, "");
    assert.equal(run(["snapshot", "--cdp", "http://127.0.0.1:6553"]).status, 0);
    assert.match(readFileSync(ledger, "utf8"), /--cdp/);
    return {
      rejected,
      sameSessionSnapshotClearedGate: true,
    };
  } finally {
    lifecycle("cleanup");
    rmSync(bin, { recursive: true, force: true });
  }
}

// Also exported for a dependency-free Linux run: the real wrapper and helper.
export function verifyBrowserCloseProof() {
  const root = mkdtempSync("/dev/shm/hackerai-browser-close-");
  rmSync(root, { recursive: true });
  const bin = mkdtempSync("/tmp/hackerai-close-cli-");
  const sockets = `${root}/sockets`;
  // A stand-in CLI: any CLOSE removes the selected (or every) socket in the
  // prepared root, as the daemon eventually does, whatever its environment says.
  writeFileSync(
    `${bin}/agent-browser`,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const dir = ${JSON.stringify(sockets)};
if (args.includes('close') && fs.existsSync(dir))
  for (const file of fs.readdirSync(dir))
    if (file.endsWith('.sock') && (args.includes('--all') || file === args[1] + '.sock'))
      fs.rmSync(dir + '/' + file);
process.exit(Number(process.env.FAKE_CLI_EXIT || 0));
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGENT_BROWSER_SESSION: "default",
    AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_CONFIG: `${root}/config.json`,
    AGENT_BROWSER_NAMESPACE: undefined,
    FAKE_CLI_EXIT: undefined,
  };
  const lifecycle = (action: "prepare" | "cleanup") => {
    const result = spawnSync(
      browserSessionCommand(action, root, Date.now() + 60_000, true),
      { shell: true, env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const run = (
    args: string[],
    overrides: Record<string, string | undefined> = {},
  ) =>
    spawnSync(`${root.replace("/dev/shm/", "/tmp/")}/bin/agent-browser`, args, {
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 5000,
    });
  /** An owned Unix socket file at the selected path, as a running daemon leaves. */
  const listen = (name: string) => {
    rmSync(`${sockets}/${name}.sock`, { force: true });
    const result = spawnSync("python3", [
      "-c",
      "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
      `${sockets}/${name}.sock`,
    ]);
    assert.equal(result.status, 0, String(result.stderr));
  };
  const helper = (request: Record<string, unknown>, name = "default") =>
    spawnSync(
      process.execPath,
      ["-e", BROWSER_DAEMON_PROGRAM, root, name, JSON.stringify(request)],
      { encoding: "utf8", timeout: 10_000 },
    );
  const optIn = { action: "stream_status", recognize_closed: true };
  const active = `${root}/active-session`;
  const proof = `${root}/closed-session`;
  const inode = (file: string) => {
    try {
      const info = lstatSync(file, { bigint: true });
      return `${info.dev}:${info.ino}`;
    } catch {
      return "absent";
    }
  };
  const proven = () =>
    inode(active) !== "absent" && inode(proof) === inode(active);
  const temporaries = () =>
    readdirSync(root).filter((file) =>
      /^\.(active|closed)-session-/.test(file),
    );
  try {
    lifecycle("prepare");
    // Every invocation publishes the same plain selection as a new private inode.
    listen("default");
    const before = inode(active);
    assert.equal(run(["open", "about:blank"]).status, 0);
    assert.notEqual(inode(active), before);
    assert.equal(readFileSync(active, "utf8"), "default");
    assert.equal(lstatSync(active).mode & 0o777, 0o600);
    assert.equal(proven(), false);

    // An exact close of the owned selected socket links the proof to that selection.
    assert.equal(run(["close"]).status, 0);
    assert.equal(proven(), true);
    assert.equal(temporaries().length, 0);
    const closed = helper(optIn);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(closed.stdout, BROWSER_DAEMON_SESSION_CLOSED);
    // Without the opt-in the unchanged missing-socket precondition remains.
    const strict = helper({ action: "stream_status" });
    assert.equal(strict.status, 2);
    assert.equal(JSON.parse(strict.stdout).diagnostic_reason, "socket_stat");

    // A later command supersedes the proof even when optional receipts cannot update.
    rmSync(`${root}/wrapper-receipt.json`, { force: true });
    mkdirSync(`${root}/wrapper-receipt.json`);
    assert.equal(run(["snapshot", "-i"]).status, 0);
    assert.equal(proven(), false);
    assert.equal(helper(optIn).status, 2);
    rmSync(`${root}/wrapper-receipt.json`, { recursive: true });

    // No proof for a failed, prefixed, redirected or empty close.
    const refused: [string[], Record<string, string | undefined>, boolean][] = [
      [["close"], { FAKE_CLI_EXIT: "1" }, true],
      [["--json", "close"], {}, true],
      [["close", "--json"], {}, true],
      [["close", "--help"], {}, true],
      [["close"], { AGENT_BROWSER_NAMESPACE: "other" }, true],
      [["close"], { AGENT_BROWSER_NAMESPACE: "" }, true],
      [["close"], { AGENT_BROWSER_SOCKET_DIR: "/tmp/other-sockets" }, true],
      [["close"], { AGENT_BROWSER_CONFIG: undefined }, true],
      // Closing nothing: the selected socket was already absent.
      [["close"], {}, false],
    ];
    for (const [args, overrides, socketBefore] of refused) {
      if (socketBefore) listen("default");
      else rmSync(`${sockets}/default.sock`, { force: true });
      const result = run(args, overrides);
      assert.equal(result.status, Number(overrides.FAKE_CLI_EXIT ?? 0));
      assert.equal(existsSync(`${sockets}/default.sock`), false);
      assert.equal(proven(), false, JSON.stringify([args, overrides]));
      assert.equal(helper(optIn).status, 2);
    }

    // close --all also closes the selected session.
    listen("default");
    assert.equal(run(["close", "--all"]).status, 0);
    assert.equal(proven(), true);
    // Reopening supersedes it before any new socket exists.
    assert.equal(run(["open", "about:blank"]).status, 0);
    assert.equal(proven(), false);
    assert.equal(helper(optIn).status, 2);

    // An unpublishable proof keeps the close result and leaves no temporaries.
    rmSync(proof, { force: true });
    mkdirSync(proof);
    listen("default");
    assert.equal(run(["close"]).status, 0);
    assert.equal(lstatSync(proof).isDirectory(), true);
    assert.equal(temporaries().length, 0);
    assert.equal(helper(optIn).status, 2);
    rmSync(proof, { recursive: true });

    // A close in another session proves only that selection.
    listen("other");
    assert.equal(run(["--session", "other", "close"]).status, 0);
    assert.equal(readFileSync(active, "utf8"), "other");
    assert.equal(proven(), true);
    assert.equal(helper(optIn, "other").stdout, BROWSER_DAEMON_SESSION_CLOSED);
    assert.equal(helper(optIn, "default").status, 2);
    return { refused: refused.length };
  } finally {
    lifecycle("cleanup");
    rmSync(bin, { recursive: true, force: true });
  }
}

// Also exported for a dependency-free Linux run: the real wrapper's OPEN receipt
// read back by the real status helper at a missing selected socket.
export function verifyBrowserOpenSocketDirectory() {
  const root = mkdtempSync("/dev/shm/hackerai-browser-directory-");
  rmSync(root, { recursive: true });
  const bin = mkdtempSync("/tmp/hackerai-directory-cli-");
  const sockets = `${root}/sockets`;
  // A stand-in CLI that never creates a socket, as when a daemon routed elsewhere.
  writeFileSync(
    `${bin}/agent-browser`,
    `#!${process.execPath}\nprocess.exit(Number(process.env.FAKE_CLI_EXIT || 0));\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGENT_BROWSER_SESSION: "default",
    AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_CONFIG: `${root}/config.json`,
    AGENT_BROWSER_NAMESPACE: undefined,
    FAKE_CLI_EXIT: undefined,
  };
  const lifecycle = (action: "prepare" | "cleanup") => {
    const result = spawnSync(
      browserSessionCommand(action, root, Date.now() + 60_000, true),
      { shell: true, env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const run = (
    args: string[],
    overrides: Record<string, string | undefined> = {},
  ) =>
    spawnSync(`${root.replace("/dev/shm/", "/tmp/")}/bin/agent-browser`, args, {
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 5000,
    });
  const status = () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        BROWSER_DAEMON_PROGRAM,
        root,
        "default",
        JSON.stringify({ action: "stream_status" }),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /PRIVATE|\/dev\/shm|\/tmp\//);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.diagnostic_reason, "socket_stat");
    assert.equal(packet.diagnostic_error, "missing");
    return packet;
  };
  const openReceipt = () => {
    const file = `${root}/open-receipt.json`;
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(text) <= 512);
    assert.doesNotMatch(text, /PRIVATE|\/dev\/shm|\/tmp\/|sockets/);
    return JSON.parse(text);
  };
  try {
    lifecycle("prepare");
    // Exact comparison only: an equivalent spelling is still another declaration.
    const declared: [Record<string, string | undefined>, number][] = [
      [{}, 0],
      [{ AGENT_BROWSER_SOCKET_DIR: undefined }, 1],
      [{ AGENT_BROWSER_SOCKET_DIR: "" }, 1],
      [{ AGENT_BROWSER_SOCKET_DIR: "/tmp/PRIVATE-sockets" }, 2],
      [{ AGENT_BROWSER_SOCKET_DIR: `${sockets}/` }, 2],
    ];
    for (const [overrides, code] of declared) {
      assert.equal(run(["open", "about:blank"], overrides).status, 0);
      const open = openReceipt();
      assert.deepEqual(
        [open.phase, open.exit, open.os1, open.o1, open.sd1],
        ["completed", 0, 2, 0, code],
        JSON.stringify(overrides),
      );
      assert.equal(Object.keys(open).at(-1), "sd1");
      const packet = status();
      assert.deepEqual([packet.os1, packet.o1, packet.sd1], [2, 0, code]);
    }

    // Not recorded beside informational tokens, a failed OPEN or an owned socket.
    const omitted: [string[], Record<string, string | undefined>][] = [
      [["open", "about:blank", "--help"], {}],
      [["open", "about:blank"], { FAKE_CLI_EXIT: "1" }],
    ];
    for (const [args, overrides] of omitted) {
      run(args, overrides);
      assert.equal(openReceipt().sd1, undefined, JSON.stringify(args));
      assert.equal(status().sd1, undefined);
    }
    const bound = spawnSync("python3", [
      "-c",
      "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
      `${sockets}/default.sock`,
    ]);
    assert.equal(bound.status, 0, String(bound.stderr));
    assert.equal(run(["open", "about:blank"]).status, 0);
    assert.deepEqual([openReceipt().os1, openReceipt().sd1], [1, undefined]);
    return { declared: declared.length, omitted: omitted.length + 1 };
  } finally {
    lifecycle("cleanup");
    rmSync(bin, { recursive: true, force: true });
  }
}

if (typeof it !== "undefined") {
  (process.platform === "linux" ? it : it.skip)(
    "resume verification rejects connection changes before and after the command",
    () => {
      verifyBrowserResumeTargets();
    },
  );
  (process.platform === "linux" ? it : it.skip)(
    "a verified close of the current selection is recognized until the next command",
    () => {
      verifyBrowserCloseProof();
    },
  );
  (process.platform === "linux" ? it : it.skip)(
    "a plain missing-socket OPEN's socket-directory declaration reaches the status helper",
    () => {
      verifyBrowserOpenSocketDirectory();
    },
  );
}
