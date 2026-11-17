// Runs the actual Debian post-install script with fixture desktop helpers on an
// isolated PATH. Registration is optional: helper failures, missing helpers
// and helpers that ignore SIGTERM must never hang or fail package installation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "deb-postinstall.sh",
);
const linuxOnly =
  process.platform === "linux"
    ? {}
    : {
        skip: "requires Linux /proc and coreutils timeout; CI runs this on Linux",
      };

// Helper budget is 5s plus a 1s SIGKILL grace. The watchdog leaves headroom for
// slow runners while still failing a hung installation well before CI limits.
const watchdogMs = 15_000;
const helperBudgetMs = 5_000;

const UPDATE = ["update-desktop-database", "/usr/share/applications"];
const XDG = [
  "xdg-mime",
  "default",
  "co.hackerai.desktop.desktop",
  "x-scheme-handler/hackerai",
];

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  assert.fail(`${name} is required on Linux to run the post-install script`);
}

/** Returns the process state and group, or null once the PID no longer exists. */
function procStat(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name may contain spaces; fields after it are fixed.
  const [state, , pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state, pgid: Number(pgid) };
}

function isRunning(pid) {
  const stat = procStat(pid);
  // A zombie has exited and only awaits reaping by its (re)parent.
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

function killQuietly(target) {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Fixture processes inherit the isolated PATH, which identifies reused PIDs. */
function belongsToFixture(pid, bin) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`PATH=${bin}`);
  } catch {
    return false;
  }
}

function createFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hackerai-deb-postinstall-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  const pids = join(dir, "pids");
  const sleep = findExecutable("sleep");
  const timeout = findExecutable("timeout");
  mkdirSync(bin);
  symlinkSync(timeout, join(bin, "timeout"));
  const ownGroup = procStat(process.pid)?.pgid;

  const recordedPids = () =>
    existsSync(pids)
      ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)
      : [];
  // Kills surviving helpers together with any descendants in their group.
  const killRecorded = () => {
    for (const pid of recordedPids()) {
      if (!isRunning(pid) || !belongsToFixture(pid, bin)) continue;
      const pgid = procStat(pid)?.pgid;
      if (pgid && pgid !== ownGroup) killQuietly(-pgid);
      killQuietly(pid);
    }
  };
  t.after(() => {
    killRecorded();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    timeout,
    recordedPids,

    /** Installs a helper that records its arguments, then succeeds, fails or stalls. */
    helper(name, mode) {
      const lines = [
        "#!/bin/sh",
        `{ printf '%s' ${quote(name)}; for arg do printf '\\t%s' "$arg"; done; printf '\\n'; } >> ${quote(calls)}`,
      ];
      if (mode === "fail") lines.push("exit 3");
      if (mode === "stall") {
        // The helper and its child both ignore SIGTERM, like a wedged tool.
        lines.push(
          "trap '' TERM",
          `${quote(sleep)} 3600 &`,
          `printf '%s\\n%s\\n' "$$" "$!" >> ${quote(pids)}`,
          "wait",
        );
      }
      const path = join(bin, name);
      writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o755 });
    },

    calls() {
      return existsSync(calls)
        ? readFileSync(calls, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("\t"))
        : [];
    },

    /** Runs the script like dpkg would, failing if it outlives the watchdog. */
    async run() {
      const outPath = join(dir, "output");
      const output = openSync(outPath, "w");
      const started = performance.now();
      // A separate group lets the watchdog kill the script and its helpers.
      // Output goes to a file so leaked descendants cannot hold a pipe open.
      const child = spawn("/bin/sh", [script], {
        cwd: dir,
        detached: true,
        env: { PATH: bin },
        stdio: ["ignore", output, output],
      });
      closeSync(output);
      let watchdog;
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const timedOut = new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(null), watchdogMs);
      });
      const result = await Promise.race([exited, timedOut]);
      clearTimeout(watchdog);
      if (result === null) {
        killQuietly(-child.pid);
        killRecorded();
        await exited;
        assert.fail(
          `post-install script did not finish within ${watchdogMs}ms; ` +
            `output: ${readFileSync(outPath, "utf8")}`,
        );
      }
      return {
        ...result,
        elapsedMs: performance.now() - started,
        output: readFileSync(outPath, "utf8"),
      };
    },
  };
}

test("registers the desktop database and URL handler", linuxOnly, async (t) => {
  const fixture = createFixture(t);
  fixture.helper("update-desktop-database", "succeed");
  fixture.helper("xdg-mime", "succeed");

  const result = await fixture.run();

  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, "");
  assert.deepEqual(fixture.calls(), [UPDATE, XDG]);
});

for (const failing of ["update-desktop-database", "xdg-mime"]) {
  test(`continues installation when ${failing} fails`, linuxOnly, async (t) => {
    const fixture = createFixture(t);
    for (const name of ["update-desktop-database", "xdg-mime"]) {
      fixture.helper(name, name === failing ? "fail" : "succeed");
    }

    const result = await fixture.run();

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, new RegExp(`warn: ${failing}\\b`));
    assert.deepEqual(fixture.calls(), [UPDATE, XDG]);
  });
}

for (const [present, expectedCalls] of [
  [[], []],
  [["xdg-mime"], [XDG]],
  [["update-desktop-database"], [UPDATE]],
]) {
  const label = present.length ? `only ${present[0]}` : "no helpers";
  test(`installs with ${label} available`, linuxOnly, async (t) => {
    const fixture = createFixture(t);
    for (const name of present) fixture.helper(name, "succeed");

    const result = await fixture.run();

    assert.equal(result.code, 0, result.output);
    assert.equal(result.output, "");
    assert.deepEqual(fixture.calls(), expectedCalls);
  });
}

for (const stalled of ["update-desktop-database", "xdg-mime"]) {
  test(
    `kills a stalled ${stalled} that ignores SIGTERM and continues`,
    linuxOnly,
    async (t) => {
      const fixture = createFixture(t);
      t.diagnostic(
        spawnSync(fixture.timeout, ["--version"], {
          encoding: "utf8",
        }).stdout.split("\n")[0],
      );
      for (const name of ["update-desktop-database", "xdg-mime"]) {
        fixture.helper(name, name === stalled ? "stall" : "succeed");
      }

      const result = await fixture.run();

      assert.equal(result.code, 0, result.output);
      assert.equal(result.signal, null);
      assert.match(result.output, new RegExp(`warn: ${stalled}\\b`));
      assert.deepEqual(fixture.calls(), [UPDATE, XDG]);
      assert.ok(
        result.elapsedMs >= helperBudgetMs,
        `helper was stopped before its ${helperBudgetMs}ms budget`,
      );

      const pids = fixture.recordedPids();
      assert.equal(pids.length, 2, "stalled helper and its child both started");
      // SIGKILL delivery to the helper group completes asynchronously after
      // timeout itself exits, so wait for it with a bounded observable check.
      const deadline = performance.now() + 2_000;
      while (pids.some(isRunning) && performance.now() < deadline) {
        await delay(10);
      }
      assert.deepEqual(
        pids.filter(isRunning),
        [],
        "no stalled helper process survives installation",
      );
    },
  );
}
