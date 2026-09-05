const mockGetOrCreate = jest.fn();
const mockGetByName = jest.fn();
const mockList = jest.fn();
import { execFile } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

jest.mock("@miosa/sdk", () => ({
  NotFoundError: class NotFoundError extends Error {},
  Miosa: jest.fn(() => ({
    sandboxes: {
      getOrCreate: (...args: unknown[]) => mockGetOrCreate(...args),
      getByName: (...args: unknown[]) => mockGetByName(...args),
      list: (...args: unknown[]) => mockList(...args),
    },
  })),
}));
import { NotFoundError } from "@miosa/sdk";

import {
  ensureMiosaSandboxConnection,
  MiosaSandbox,
  miosaCancellationCommand,
  terminateMiosaSandboxesForUser,
} from "../miosa-sandbox";

const createSdkSandbox = () => ({
  id: "miosa-1",
  state: "running",
  templateId: "hackerai-kali-promoted",
  data: { id: "miosa-1", state: "running", boot_path: "created" },
  exec: {
    run: jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    stream: jest.fn(async function* () {
      yield { type: "exit", exit_code: 0 };
    }),
  },
  files: {
    write: jest.fn(),
    readText: jest.fn(),
    list: jest.fn(),
    stat: jest.fn(),
  },
  extend: jest.fn(),
  refresh: jest.fn(),
  getHost: jest.fn(),
  usage: jest.fn(async () => ({ estimated_cost_cents: 0 })),
});

describe("MIOSA sandbox adapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      MIOSA_API_KEY: "msk_test",
      MIOSA_TEMPLATE_ID: "hackerai-kali-promoted",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("creates or resumes a stable persistent per-user workspace", async () => {
    const sdkSandbox = createSdkSandbox();
    mockGetOrCreate.mockResolvedValue(sdkSandbox);
    const setSandbox = jest.fn();
    const onBoot = jest.fn();

    const result = await ensureMiosaSandboxConnection({
      userID: "user-1",
      setSandbox,
      onBoot,
    });

    expect(result.sandbox).toBeInstanceOf(MiosaSandbox);
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^hackerai-[a-f0-9]{24}-v2$/),
        templateId: "hackerai-kali-promoted",
        cpuCount: 4,
        memoryMb: 4096,
        diskSizeMb: 20480,
        persistent: true,
        idleTimeoutSec: 420,
        waitUntilReady: true,
        externalUserId: expect.stringMatching(/^hackerai-[a-f0-9]{24}$/),
      }),
    );
    expect(sdkSandbox.exec.stream).toHaveBeenCalledWith(
      expect.stringMatching(
        /mkdir -p \/home\/user\/upload[\s\S]*docker image inspect[\s\S]*docker run -d[\s\S]*hackerai-agent/,
      ),
      { timeoutSec: 900 },
    );
    expect(setSandbox).toHaveBeenCalledWith(result.sandbox);
    expect(onBoot).toHaveBeenCalledWith(
      expect.objectContaining({ path: "create_fresh", create_attempts: 1 }),
    );
  });

  it("rejects acquisition when no promoted template is configured", async () => {
    delete process.env.MIOSA_TEMPLATE_ID;

    await expect(
      ensureMiosaSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      }),
    ).rejects.toThrow(
      "MIOSA_TEMPLATE_ID must identify the promoted HackerAI sandbox template",
    );
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("checks new enrollment only after the canonical workspace is confirmed absent", async () => {
    mockGetByName.mockRejectedValueOnce(new NotFoundError("missing"));
    mockGetOrCreate.mockResolvedValue(createSdkSandbox());
    const beforeCreate = jest.fn(async () => {
      expect(mockGetOrCreate).not.toHaveBeenCalled();
    });
    await ensureMiosaSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { beforeCreate },
    );
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(mockGetByName).toHaveBeenCalledWith(
      expect.stringMatching(/^hackerai-[a-f0-9]{24}-v2$/),
    );
    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
  });

  it("does not create when the new enrollment guard refuses", async () => {
    mockGetByName.mockRejectedValueOnce(new NotFoundError("missing"));
    const beforeCreate = jest
      .fn()
      .mockRejectedValue(new Error("existing E2B workspace"));
    await expect(
      ensureMiosaSandboxConnection(
        { userID: "user-1", setSandbox: jest.fn() },
        { beforeCreate },
      ),
    ).rejects.toThrow("existing E2B workspace");
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it.each(["running", "paused"])(
    "reuses a %s Miosa assignment without re-enrolling",
    async (state) => {
      mockGetByName.mockResolvedValueOnce({ state });
      mockGetOrCreate.mockResolvedValue(createSdkSandbox());
      const beforeCreate = jest.fn();
      await ensureMiosaSandboxConnection(
        { userID: "user-1", setSandbox: jest.fn() },
        { beforeCreate },
      );
      expect(beforeCreate).not.toHaveBeenCalled();
      expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat Miosa discovery failure as a missing workspace", async () => {
    mockGetByName.mockRejectedValueOnce(new Error("network error"));
    const beforeCreate = jest.fn();
    await expect(
      ensureMiosaSandboxConnection(
        { userID: "user-1", setSandbox: jest.fn() },
        { beforeCreate },
      ),
    ).rejects.toThrow("network error");
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("does not initialize or expose a sandbox that is not running", async () => {
    const sdk = createSdkSandbox();
    sdk.state = "provisioning";
    mockGetOrCreate.mockResolvedValue(sdk);
    const setSandbox = jest.fn();
    await expect(
      ensureMiosaSandboxConnection({ userID: "user-1", setSandbox }),
    ).rejects.toThrow("non-running state: provisioning");
    expect(setSandbox).not.toHaveBeenCalled();
    expect(sdk.exec.stream).not.toHaveBeenCalled();
  });

  it("preserves stream chunks, trailing newlines, carriage returns and Unicode", async () => {
    const sdk = createSdkSandbox();
    sdk.exec.stream.mockImplementation(async function* () {
      yield { type: "stdout", data: "part" };
      yield { type: "stdout", data: "ial\n\n雪\r" };
      yield { type: "stderr", data: "warn\n" };
      yield { type: "exit", exit_code: 7 };
    } as never);
    const onStdout = jest.fn();
    const onStderr = jest.fn();
    await expect(
      new MiosaSandbox(sdk as never).commands.run("test", {
        onStdout,
        onStderr,
      }),
    ).resolves.toEqual({
      stdout: "partial\n\n雪\r",
      stderr: "warn\n",
      exitCode: 7,
    });
    expect(onStdout.mock.calls).toEqual([["part"], ["ial\n\n雪\r"]]);
    expect(onStderr.mock.calls).toEqual([["warn\n"]]);
  });

  it("waits for the abortable process group and preserves its late output and exit status", async () => {
    const sdk = createSdkSandbox();
    sdk.exec.stream.mockImplementation(async function* () {
      yield { type: "stdout", data: "before\n" };
      await Promise.resolve();
      yield { type: "stdout", data: "after\n" };
      yield { type: "stderr", data: "late-warning\n" };
      yield { type: "exit", exit_code: 7 };
    } as never);
    const signal = new AbortController().signal;
    await expect(
      new MiosaSandbox(sdk as never).commands.run("sleep 2; exit 7", {
        signal,
      }),
    ).resolves.toEqual({
      stdout: "before\nafter\n",
      stderr: "late-warning\n",
      exitCode: 7,
    });
    expect(sdk.exec.stream).toHaveBeenCalledWith(
      expect.stringContaining("setsid --wait bash -lc"),
      { signal },
    );
    expect(sdk.exec.run).not.toHaveBeenCalled();
  });

  it("destroys every persistent sandbox belonging to the requested user", async () => {
    const firstDestroy = jest.fn().mockResolvedValue(undefined);
    const secondDestroy = jest.fn().mockResolvedValue(undefined);
    mockList.mockResolvedValue([
      { state: "running", destroy: firstDestroy },
      { state: "paused", destroy: secondDestroy },
    ]);

    await expect(terminateMiosaSandboxesForUser("user-1")).resolves.toEqual({
      total: 2,
      killed: 2,
      alreadyGone: 0,
    });
    expect(mockList).toHaveBeenCalledWith({
      externalUserId: expect.stringMatching(/^hackerai-[a-f0-9]{24}$/),
    });
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed stream payloads without calling text consumers", async () => {
    const sdk = createSdkSandbox();
    sdk.exec.stream.mockImplementation(async function* () {
      yield { type: "stdout" };
      yield { type: "stderr", data: null };
      yield { type: "stdout", data: 7 };
      yield { type: "stdout", line: "valid\n" };
      yield { type: "exit", exit_code: 0 };
    } as never);
    const onStdout = jest.fn();
    const onStderr = jest.fn();
    await expect(
      new MiosaSandbox(sdk as never).commands.run("test", {
        onStdout,
        onStderr,
      }),
    ).resolves.toEqual({ stdout: "valid\n", stderr: "", exitCode: 0 });
    expect(onStdout.mock.calls).toEqual([["valid\n"]]);
    expect(onStderr).not.toHaveBeenCalled();
  });

  it("maps streaming stdout, stderr, and exit status", async () => {
    const sdkSandbox = createSdkSandbox();
    async function* stream() {
      yield { type: "stdout", line: "hello" };
      yield { type: "stderr", line: "warning" };
      yield { type: "exit", exit_code: 7 };
    }
    sdkSandbox.exec.stream.mockImplementation(stream);
    const sandbox = new MiosaSandbox(sdkSandbox as never);
    const onStdout = jest.fn();
    const onStderr = jest.fn();

    await expect(
      sandbox.commands.run("example", { onStdout, onStderr, timeoutMs: 1500 }),
    ).resolves.toEqual({
      stdout: "hello",
      stderr: "warning",
      exitCode: 7,
    });
    expect(sdkSandbox.exec.stream).toHaveBeenCalledWith(
      expect.stringMatching(
        /docker exec[\s\S]*hackerai-agent[\s\S]*bash -lc[\s\S]*example/,
      ),
      { timeoutSec: 2 },
    );
    expect(onStdout).toHaveBeenCalledWith("hello");
    expect(onStderr).toHaveBeenCalledWith("warning");
  });

  it("rejects a command stream that ends without an exit event", async () => {
    const sdkSandbox = createSdkSandbox();
    async function* stream() {
      yield { type: "stdout", line: "partial output" };
      yield { type: "timeout" };
    }
    sdkSandbox.exec.stream.mockImplementation(stream);
    const sandbox = new MiosaSandbox(sdkSandbox as never);

    await expect(sandbox.commands.run("example")).rejects.toThrow(
      "MIOSA command stream ended without an exit event",
    );
  });

  it("starts background commands without waiting for their completion", async () => {
    const sdkSandbox = createSdkSandbox();
    sdkSandbox.exec.run.mockResolvedValue({
      stdout: "4321",
      stderr: "",
      exitCode: 0,
    });
    const sandbox = new MiosaSandbox(sdkSandbox as never);

    await expect(
      sandbox.commands.run("npm run dev", { background: true }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0, pid: 4321 });
    expect(sdkSandbox.exec.run).toHaveBeenCalledWith(
      expect.stringMatching(
        /docker exec[\s\S]*hackerai-agent[\s\S]*nohup bash -lc/,
      ),
      {},
    );
  });

  it("terminates the remote process group when a foreground command is aborted", async () => {
    const sdkSandbox = createSdkSandbox();
    let finishStream: (() => void) | undefined;
    const streamFinished = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    async function* stream() {
      await streamFinished;
    }
    sdkSandbox.exec.stream.mockImplementation(stream);
    sdkSandbox.exec.run.mockImplementation(async () => {
      finishStream?.();
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const sandbox = new MiosaSandbox(sdkSandbox as never);
    const controller = new AbortController();
    const command = sandbox.commands.run("sleep 60", {
      signal: controller.signal,
    });

    controller.abort();

    await expect(command).rejects.toMatchObject({ name: "AbortError" });
    expect(sdkSandbox.exec.stream).toHaveBeenCalledWith(
      expect.stringMatching(
        /docker exec[\s\S]*hackerai-agent[\s\S]*setsid --wait bash -lc/,
      ),
      { signal: controller.signal },
    );
    expect(sdkSandbox.exec.run).toHaveBeenCalledWith(
      expect.stringMatching(
        /docker exec[\s\S]*hackerai-agent[\s\S]*kill -TERM --/,
      ),
      { timeoutSec: 5 },
    );
  });

  it("maps cwd and environment variables into the Kali container", async () => {
    const sdkSandbox = createSdkSandbox();
    async function* stream() {
      yield { type: "exit", exit_code: 0 };
    }
    sdkSandbox.exec.stream.mockImplementation(stream);
    const sandbox = new MiosaSandbox(sdkSandbox as never);

    await sandbox.commands.run("pwd", {
      cwd: "/home/user/workspace",
      envVars: { TARGET_HOST: "example.com" },
    });

    expect(sdkSandbox.exec.stream).toHaveBeenCalledWith(
      expect.stringMatching(
        /docker exec --workdir '\/home\/user\/workspace' --env 'TARGET_HOST=example\.com' 'hackerai-agent'/,
      ),
      {},
    );
  });

  it.each([
    new DOMException("native abort", "AbortError"),
    new Error("stream transport failed"),
  ])(
    "waits for cancellation cleanup after stream rejection: %s",
    async (error) => {
      const sdk = createSdkSandbox();
      const controller = new AbortController();
      sdk.exec.stream.mockImplementation(async function* () {
        await new Promise<void>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(error), {
            once: true,
          });
        });
      } as never);
      let finishKill!: () => void;
      sdk.exec.run.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finishKill = resolve;
        });
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const pending = new MiosaSandbox(sdk as never).commands.run("sleep 60", {
        signal: controller.signal,
      });
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      controller.abort();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(settled).toBe(false);
      finishKill();
      if (error.name === "AbortError")
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      else await expect(pending).rejects.toBe(error);
    },
  );

  it("does not report confirmed cancellation when the remote kill command fails", async () => {
    const sdk = createSdkSandbox();
    sdk.exec.stream.mockImplementation(async function* () {
      await new Promise(() => {});
    } as never);
    sdk.exec.run.mockResolvedValue({
      stdout: "",
      stderr: "unavailable",
      exitCode: 1,
    });
    const controller = new AbortController();
    const pending = new MiosaSandbox(sdk as never).commands.run("sleep 60", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(
      "MIOSA command cancellation could not be confirmed",
    );
  });

  it("reports unconfirmed cancellation after every PID-file check is exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "miosa-cancel-test-"));
    const sdk = createSdkSandbox();
    sdk.exec.stream.mockImplementation(async function* () {
      await new Promise(() => {});
    } as never);
    sdk.exec.run.mockImplementation(async () => {
      try {
        await promisify(execFile)(
          "/bin/bash",
          [
            "-c",
            miosaCancellationCommand(join(directory, "never-created.pid")),
          ],
          { timeout: 5000 },
        );
        return { stdout: "", stderr: "", exitCode: 0 };
      } catch (error) {
        expect(error).toMatchObject({ code: 1 });
        return { stdout: "", stderr: "", exitCode: 1 };
      }
    });
    try {
      const controller = new AbortController();
      const pending = new MiosaSandbox(sdk as never).commands.run("sleep 60", {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toThrow(
        "MIOSA command cancellation could not be confirmed",
      );
      expect(sdk.exec.run).toHaveBeenCalledTimes(1);
    } finally {
      rmdirSync(directory);
    }
  });
});
