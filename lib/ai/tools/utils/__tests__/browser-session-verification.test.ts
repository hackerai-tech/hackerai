import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { browserSessionCommand } from "../browser-session-program";

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
    ]) {
      writeFileSync(ledger, "");
      assert.equal(run(["snapshot", "-i"], overrides).status, 75);
      assert.equal(existsSync(`${root}/verify-required`), true);
      assert.equal(readFileSync(ledger, "utf8"), "");
      rejected++;
    }
    assert.notEqual(run(["--session", "other", "snapshot", "-i"]).status, 0);
    assert.equal(existsSync(`${root}/verify-required`), true);
    assert.equal(run(["--json", "snapshot", "-i", "--compact"]).status, 0);
    assert.equal(existsSync(`${root}/verify-required`), false);
    assert.equal(readFileSync(`${root}/active-session`, "utf8"), "kept");
    // Once the original browser has been inspected, ordinary options work again.
    writeFileSync(ledger, "");
    assert.equal(run(["snapshot", "--cdp", "http://127.0.0.1:6553"]).status, 0);
    assert.match(readFileSync(ledger, "utf8"), /--cdp/);
    return { rejected, sameSessionSnapshotClearedGate: true };
  } finally {
    lifecycle("cleanup");
    rmSync(bin, { recursive: true, force: true });
  }
}

if (typeof it !== "undefined")
  (process.platform === "linux" ? it : it.skip)(
    "resume verification rejects connection changes before and after the command",
    () => {
      verifyBrowserResumeTargets();
    },
  );
