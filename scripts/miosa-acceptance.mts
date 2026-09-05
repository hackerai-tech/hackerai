/** Live, billable acceptance against disposable workspaces only.
 * Run: pnpm exec tsx scripts/miosa-acceptance.mts --cli-auth
 * Credentials are read in memory, never printed. No deployment settings change.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Miosa } from "@miosa/sdk";
import {
  ensureMiosaSandboxConnection,
  terminateMiosaSandboxesForUser,
} from "../lib/ai/tools/utils/miosa-sandbox";
import { createMiosaPtyHandle } from "../lib/ai/tools/utils/miosa-pty-adapter";

if (process.argv.includes("--cli-auth")) {
  const config = JSON.parse(
    readFileSync(`${homedir()}/.miosa/config.json`, "utf8"),
  );
  assert.equal(typeof config.api_key, "string");
  process.env.MIOSA_API_KEY = config.api_key;
}
assert.ok(
  process.env.MIOSA_API_KEY,
  "Set MIOSA_API_KEY or explicitly pass --cli-auth",
);
process.env.MIOSA_TEMPLATE_ID =
  process.env.MIOSA_TEMPLATE_ID?.trim() || "miosa-sandbox-docker";
const client = new Miosa({
  apiKey: process.env.MIOSA_API_KEY,
  ...(process.env.MIOSA_BASE_URL && { baseUrl: process.env.MIOSA_BASE_URL }),
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const log = (test: string, details: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ utc: new Date().toISOString(), test, ...details }),
  );
function safeError(error: unknown) {
  const e = error as {
    name?: string;
    code?: string;
    status?: number;
    requestId?: string;
    message?: string;
  };
  return {
    name: e.name,
    code: e.code,
    status: e.status,
    requestId: e.requestId,
    message: e.message?.replaceAll(process.env.MIOSA_API_KEY!, "[redacted]"),
  };
}
let failures = 0;
const attempts = Number(
  process.argv.find((arg) => arg.startsWith("--attempts="))?.split("=")[1] ?? 2,
);
assert.ok(
  Number.isInteger(attempts) && attempts >= 1 && attempts <= 10,
  "--attempts must be 1 through 10",
);
for (let attempt = 1; attempt <= attempts; attempt++) {
  const userID = `miosa-acceptance-${randomUUID()}`;
  const externalUserId = `hackerai-${createHash("sha256").update(userID).digest("hex").slice(0, 24)}`;
  const check = async (name: string, run: () => Promise<unknown>) => {
    const start = Date.now();
    try {
      const result = await run();
      log(name, { attempt, pass: true, ms: Date.now() - start, result });
    } catch (error) {
      failures++;
      log(name, {
        attempt,
        pass: false,
        ms: Date.now() - start,
        error: safeError(error),
      });
    }
  };
  log("create_start", { attempt, externalUserId });
  try {
    const start = Date.now();
    const context = { userID, setSandbox() {} };
    const { sandbox } = await ensureMiosaSandboxConnection(context);
    log("create_ready", {
      attempt,
      ms: Date.now() - start,
      sandboxId: sandbox.sandboxId,
      state: sandbox.sdkSandbox.state,
      operationId: sandbox.sdkSandbox.data.operation_id,
      requestId: sandbox.sdkSandbox.data.request_id,
      bootPath: sandbox.sdkSandbox.data.boot_path,
      bootMs: sandbox.sdkSandbox.data.boot_ms,
    });
    const run = async (command: string) => {
      const r = await sandbox.commands.run(command, { timeoutMs: 30000 });
      assert.equal(r.exitCode, 0, r.stderr);
      return r.stdout;
    };
    await check("shape_kernel_tools", async () => {
      const d = sandbox.sdkSandbox.data;
      assert.equal(d.cpu_count, 4);
      assert.equal(d.memory_mb, 4096);
      assert.equal(d.disk_size_mb, 20480);
      const info = await run(
        "uname -r; pwd; command -v nmap nuclei ffuf agent-browser; nmap --version | head -1; nuclei -version 2>&1; ffuf -V",
      );
      assert.ok(info.includes("/usr/bin/nmap"));
      return info;
    });
    await check("stream_exact_chunks_and_exit", async () => {
      const stdout: string[] = [],
        stderr: string[] = [];
      const r = await sandbox.commands.run(
        "printf 'partial'; sleep 0.1; printf ' line\\n\\n雪\\r'; printf 'warning\\n' >&2; exit 7",
        {
          timeoutMs: 10000,
          onStdout: (s) => stdout.push(s),
          onStderr: (s) => stderr.push(s),
        },
      );
      assert.equal(r.exitCode, 7);
      assert.equal(r.stdout, "partial line\n\n雪\r");
      assert.equal(stdout.join(""), r.stdout);
      assert.equal(r.stderr, "warning\n");
      assert.equal(stderr.join(""), r.stderr);
      return { stdoutChunks: stdout.length, stderrChunks: stderr.length };
    });
    await check("abortable_stream_waits_for_child_exit", async () => {
      const stdout: string[] = [],
        stderr: string[] = [];
      const started = Date.now();
      const r = await sandbox.commands.run(
        "printf 'before\\n'; sleep 2; printf 'after\\n'; printf 'late-warning\\n' >&2; exit 7",
        {
          // Agent foreground commands always carry a signal, even when the
          // user never cancels. Exercise that process-group wrapper too.
          signal: new AbortController().signal,
          timeoutMs: 10000,
          onStdout: (s) => stdout.push(s),
          onStderr: (s) => stderr.push(s),
        },
      );
      assert.equal(r.exitCode, 7);
      assert.equal(r.stdout, "before\nafter\n");
      assert.equal(r.stderr, "late-warning\n");
      assert.equal(stdout.join(""), r.stdout);
      assert.equal(stderr.join(""), r.stderr);
      assert.ok(Date.now() - started >= 2000, "returned before child exited");
      return { stdoutChunks: stdout.length, stderrChunks: stderr.length };
    });
    await check("files_container_namespace", async () => {
      const content = "snow 雪, quote ', trailing\n\n";
      for (const path of [
        "/home/user/a '雪.txt",
        "/tmp/a '雪.txt",
        "/workspace/a '雪.txt",
        "relative '雪.txt",
      ]) {
        await sandbox.files.write(path, content);
        assert.equal(await run(`cat -- ${quote(path)}`), content);
        assert.equal(await sandbox.files.read(path), content);
        await run(`printf 'append' >> ${quote(path)}`);
        assert.equal(await sandbox.files.read(path), content + "append");
        assert.equal(
          (await sandbox.files.stat(path)).size,
          Buffer.byteLength(content + "append"),
        );
        assert.equal(await sandbox.files.exists(path), true);
        await sandbox.files.remove(path);
        assert.equal(await sandbox.files.exists(path), false);
      }
      const binary = Buffer.alloc(1024 * 1024 + 37);
      for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
      await sandbox.files.write("/tmp/binary.bin", binary);
      assert.equal(
        (await run("sha256sum /tmp/binary.bin")).split(" ")[0],
        createHash("sha256").update(binary).digest("hex"),
      );
      await sandbox.files.remove("/tmp/binary.bin");
      assert.equal(
        (await sandbox.files.list("/home/user")).some((f) =>
          f.name.startsWith(".hackerai-transfer-"),
        ),
        false,
      );
    });
    await check("cancel_descendants", async () => {
      const marker = `/home/user/cancel-${randomUUID()}`;
      const controller = new AbortController();
      let began = false;
      const promise = sandbox.commands.run(
        `printf 'STARTED\\n'; (sleep 5; printf 'LEAK' > ${quote(marker)}) & wait`,
        {
          signal: controller.signal,
          timeoutMs: 15000,
          onStdout: (s) => {
            if (s.includes("STARTED")) {
              began = true;
              controller.abort();
            }
          },
        },
      );
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        await assert.rejects(promise, { name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
      assert.ok(began, "command never reached STARTED");
      await delay(6000);
      assert.equal(
        await sandbox.files.exists(marker),
        false,
        "child process survived cancellation",
      );
    });
    await check("interactive_container_resize_ctrl_c", async () => {
      const pty = await createMiosaPtyHandle(sandbox, {
        cols: 100,
        rows: 30,
        cwd: "/home/user",
        envs: { HACKERAI_ACCEPTANCE: "env-ok" },
      });
      let output = "";
      const decoder = new TextDecoder();
      const unsub = pty.onData((bytes) => {
        output += decoder.decode(bytes, { stream: true });
      });
      const waitFor = async (value: string) => {
        const deadline = Date.now() + 10000;
        while (!output.includes(value) && Date.now() < deadline)
          await delay(50);
        assert.ok(
          output.includes(value),
          `PTY missing ${value}: ${output.slice(-1500)}`,
        );
      };
      const send = async (cmd: string) => pty.sendInput(Buffer.from(cmd));
      const marker = randomUUID();
      try {
        await send(
          `printf '%s%s\\n' ${quote(marker.slice(0, 18))} ${quote(marker.slice(18))}; pwd; command -v nuclei; printf '%s\\n' "$HACKERAI_ACCEPTANCE"\n`,
        );
        await waitFor(marker);
        await waitFor("/usr/bin/nuclei");
        await waitFor("env-ok\r\n");
        await pty.resize(111, 37);
        await delay(150);
        await send("stty size\n");
        await waitFor("37 111");
        await send("sleep 20\n");
        await delay(300);
        await send("\x03");
        const done = randomUUID();
        await send(
          `printf '%s%s\\n' ${quote(done.slice(0, 18))} ${quote(done.slice(18))}\n`,
        );
        await waitFor(done);
      } finally {
        unsub();
        await pty.kill();
        await pty.exited;
      }
    });
    await check("localhost_port_scan_and_browser", async () => {
      const result = await run(
        "nmap -sS -Pn -p 1 127.0.0.1; agent-browser open 'data:text/html,<title>HackerAI acceptance</title><h1>ok</h1>' >/dev/null && agent-browser get title; agent-browser close >/dev/null",
      );
      assert.ok(result.includes("1/tcp"));
      assert.ok(result.includes("HackerAI acceptance"));
      return result;
    });
    await check("persistent_reconnect", async () => {
      await sandbox.files.write("/home/user/persistence-check", "survived");
      const again = await ensureMiosaSandboxConnection(context);
      assert.equal(again.sandbox.sandboxId, sandbox.sandboxId);
      assert.equal(
        await again.sandbox.files.read("/home/user/persistence-check"),
        "survived",
      );
    });
    await check("background_kill", async () => {
      const marker = `/home/user/background-${randomUUID()}`;
      const background = await sandbox.commands.run(
        `sleep 5; printf LEAK > ${quote(marker)}`,
        { background: true },
      );
      assert.ok(background.pid && background.pid > 0);
      assert.equal(await sandbox.commands.kill(background.pid), true);
      await delay(6000);
      assert.equal(
        await sandbox.files.exists(marker),
        false,
        "background survived kill",
      );
    });
    await check("usage_monotonic", async () => {
      const first = await sandbox.sdkSandbox.usage();
      await delay(1200);
      const second = await sandbox.sdkSandbox.usage();
      assert.equal(first.sandbox_id, sandbox.sandboxId);
      assert.equal(second.sandbox_id, sandbox.sandboxId);
      assert.ok(second.runtime_sec >= first.runtime_sec);
      assert.ok(second.estimated_cost_cents >= first.estimated_cost_cents);
      return {
        runtimeSec: second.runtime_sec,
        estimatedCostCents: second.estimated_cost_cents,
      };
    });
    await check("port_exposure", async () => {
      await sandbox.files.write(
        "/home/user/acceptance-http/index.html",
        "disposable-port-test",
      );
      const server = await sandbox.commands.run(
        "exec python3 -m http.server 8765 --bind 0.0.0.0 --directory /home/user/acceptance-http",
        { background: true },
      );
      assert.ok(server.pid);
      try {
        await delay(500);
        const host = await sandbox.getHost(8765);
        const response = await fetch(`https://${host}`, {
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "disposable-port-test");
      } finally {
        await sandbox.commands.kill(server.pid);
      }
    });
    await check("pause_resume_persistence", async () => {
      await sandbox.sdkSandbox.pause();
      const deadline = Date.now() + 60000;
      while (sandbox.sdkSandbox.state !== "paused") {
        assert.ok(Date.now() < deadline, "pause did not settle");
        await delay(1000);
        await sandbox.sdkSandbox.refresh();
      }
      const again = await ensureMiosaSandboxConnection(context);
      assert.equal(again.sandbox.sandboxId, sandbox.sandboxId);
      assert.equal(again.sandbox.sdkSandbox.state, "running");
      assert.equal(
        await again.sandbox.files.read("/home/user/persistence-check"),
        "survived",
      );
    });
  } catch (error) {
    failures++;
    log("acquisition_failure", { attempt, error: safeError(error) });
  } finally {
    await check("settings_delete_and_readback", async () => {
      const result = await terminateMiosaSandboxesForUser(userID);
      const deadline = Date.now() + 60000;
      while (true) {
        const remaining = (
          await client.sandboxes.list({ externalUserId })
        ).filter((s) => s.state !== "destroyed");
        if (!remaining.length) break;
        assert.ok(Date.now() < deadline, "sandbox not destroyed after 60s");
        await delay(2000);
      }
      return result;
    });
  }
}
log("summary", { failures });
process.exitCode = failures ? 1 : 0;
