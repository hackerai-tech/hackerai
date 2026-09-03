const mockGetOrCreate = jest.fn();
const mockList = jest.fn();

jest.mock("@miosa/sdk", () => ({
  Miosa: jest.fn(() => ({
    sandboxes: {
      getOrCreate: (...args: unknown[]) => mockGetOrCreate(...args),
      list: (...args: unknown[]) => mockList(...args),
    },
  })),
}));

import {
  ensureMiosaSandboxConnection,
  MiosaSandbox,
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
    expect(onStdout).toHaveBeenCalledWith("hello\n");
    expect(onStderr).toHaveBeenCalledWith("warning\n");
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
        /docker exec[\s\S]*hackerai-agent[\s\S]*setsid bash -lc/,
      ),
      {},
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
});
