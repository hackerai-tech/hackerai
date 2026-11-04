import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { BROWSERLESS_RESTORE_PROGRAM } from "../../../captcha/browserless-adopt-program";
import { browserSessionCommand } from "../browser-session-program";

// Real Linux flock and generated CLI wrapper, with only the downstream browser
// executable replaced. This catches routing to the wrong daemon after recovery.
(process.platform === "linux" ? it : it.skip)(
  "recovers a busy or interrupted fallback into the original named session",
  async () => {
    const root = mkdtempSync("/dev/shm/hackerai-browser-recovery-");
    rmSync(root, { recursive: true }); // prepare owns creation.
    const bin = mkdtempSync("/tmp/hackerai-recovery-cli-");
    writeFileSync(
      `${bin}/agent-browser`,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AGENT_BROWSER_SESSION: "default",
    };
    const run = (args: string[]) =>
      spawnSync(
        `${root.replace("/dev/shm/", "/tmp/")}/bin/agent-browser`,
        args,
        { env, encoding: "utf8", timeout: 5000 },
      );
    const selectFallback = (active: string) => {
      writeFileSync(`${root}/active-session`, active);
      writeFileSync(
        `${root}/fallback-session`,
        JSON.stringify({
          name: "fallback-test",
          original: "named-original",
          endpoint: "ws://127.0.0.1:1/",
        }),
      );
    };
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const prepared = spawnSync(
        browserSessionCommand("prepare", root, Date.now() + 60_000, true),
        { shell: true, env, encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(prepared.status, 0, prepared.stderr);

      // Activation/restoration interrupted with original already selected.
      selectFallback("named-original");
      assert.equal(run(["get", "title"]).status, 75);
      assert.equal(
        readFileSync(`${root}/active-session`, "utf8"),
        "named-original",
      );
      assert.notEqual(run(["--session", "other", "snapshot"]).status, 0);
      const snapshot = run(["snapshot", "-i"]);
      assert.equal(snapshot.status, 0, snapshot.stderr);
      assert.deepEqual(JSON.parse(snapshot.stdout), [
        "--session",
        "named-original",
        "snapshot",
        "-i",
      ]);
      assert.deepEqual(JSON.parse(run(["get", "title"]).stdout), [
        "--session",
        "named-original",
        "get",
        "title",
      ]);

      // Hold the real gate beyond restoration's bounded eight-second wait.
      selectFallback("fallback-test");
      holder = spawn(
        "python3",
        [
          "-c",
          "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",
          `${root}/gate.lock`,
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      await once(holder.stdout!, "data");
      const restore = spawnSync(
        "python3",
        ["-c", BROWSERLESS_RESTORE_PROGRAM, root],
        {
          input: JSON.stringify({
            name: "named-original",
            remoteName: "fallback-test",
          }),
          encoding: "utf8",
          timeout: 12_000,
        },
      );
      assert.equal(restore.status, 0, restore.stderr);
      assert.deepEqual(JSON.parse(restore.stdout), {
        restored: false,
        deferred: true,
      });
      holder.stdin!.end();
      await once(holder, "close");
      assert.equal(run(["get", "title"]).status, 75);
      assert.equal(existsSync(`${root}/fallback-session`), false);
      const recovered = run(["snapshot", "-i"]);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(JSON.parse(recovered.stdout), [
        "--session",
        "named-original",
        "snapshot",
        "-i",
      ]);
    } finally {
      holder?.kill();
      spawnSync(browserSessionCommand("cleanup", root, 0), {
        shell: true,
        env,
        timeout: 5000,
        stdio: "ignore",
      });
      rmSync(root, { recursive: true, force: true });
      rmSync(root.replace("/dev/shm/", "/tmp/"), {
        recursive: true,
        force: true,
      });
      rmSync(bin, { recursive: true, force: true });
    }
  },
  25_000,
);
