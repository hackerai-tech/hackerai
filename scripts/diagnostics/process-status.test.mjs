import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  getProcessStatus,
  parseProcessStatus,
  main,
} from "./process-status.mjs";

const sentinel = "SYNTHETIC_DIAGNOSTIC_SECRET_987654";
test("process health retains useful fields without arbitrary executable paths", () => {
  const result = parseProcessStatus(
    " 42 1 S+ 01:02 3.5 0.2 /private/" +
      sentinel +
      "/node\n43 1 R 1-02:03:04 0.0 0.0 " +
      sentinel +
      "\n",
    [42, 43],
  );
  assert.equal(result.processes[0].executable, "node");
  assert.equal(result.processes[0].elapsedSeconds, 62);
  assert.equal(result.processes[1].elapsedSeconds, 93784);
  assert.equal(result.processes[1].executable, "other");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});
test("malformed, extra, duplicate and multiline process data fail without echoing it", async () => {
  for (const stdout of [
    "42 1 S 00:01 0.0 0.0 node\nTOKEN=" + sentinel,
    "99 1 S 00:01 0.0 0.0 node",
    "42 1 S 00:01 0.0 0.0 node\n42 1 S 00:01 0.0 0.0 node",
    "42 1 S 00:99 0.0 0.0 node",
    "42 1 S 00:01 0.0 101.0 node",
    sentinel.repeat(3000),
  ]) {
    const result = await getProcessStatus([42], {
      run: async () => ({ stdout, stderr: "" }),
    });
    assert.deepEqual(result, { ok: false, reason: "invalid-output" });
  }
});
test("process errors and stderr never escape through exceptions or JSON", async () => {
  const failed = await getProcessStatus([42], {
    run: async () => {
      throw new Error(sentinel);
    },
  });
  assert.deepEqual(failed, { ok: false, reason: "process-inspection-failed" });
  assert.deepEqual(
    await getProcessStatus([42], {
      run: async () => ({ stdout: "", stderr: sentinel }),
    }),
    { ok: false, reason: "invalid-output" },
  );
});
test("invalid selections fail before querying ps; missing processes are explicit", async () => {
  for (const pids of [[], [0], [-1], ["42"], [1.5], Array(17).fill(42)]) {
    assert.deepEqual(
      await getProcessStatus(pids, { run: () => assert.fail("must not run") }),
      { ok: false, reason: "invalid-pids" },
    );
  }
  assert.deepEqual(await main(["42;echo", sentinel]), {
    ok: false,
    reason: "invalid-pids",
  });
  assert.deepEqual(
    await getProcessStatus([42], {
      run: async () => ({ stdout: "", stderr: "" }),
    }),
    { ok: true, processes: [], missingPids: [42] },
  );
});
test(
  "actual ps hides synthetic command arguments and environment values",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", sentinel],
      {
        env: {
          PATH: process.env.PATH,
          DIAGNOSTIC_FIXTURE_TOKEN: sentinel + "\nSECOND_SYNTHETIC_SECRET_LINE",
        },
        stdio: "ignore",
      },
    );
    try {
      await once(child, "spawn");
      const result = await getProcessStatus([child.pid]);
      assert.equal(result.ok, true);
      assert.equal(result.processes[0].pid, child.pid);
      assert.equal(result.processes[0].executable, "node");
      assert.equal(JSON.stringify(result).includes(sentinel), false);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  },
);
