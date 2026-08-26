const mockGetOrCreate = jest.fn();

jest.mock("@miosa/sdk", () => ({
  Miosa: jest.fn(() => ({
    sandboxes: {
      getOrCreate: (...args: unknown[]) => mockGetOrCreate(...args),
    },
  })),
}));

import { ensureMiosaSandboxConnection, MiosaSandbox } from "../miosa-sandbox";

const createSdkSandbox = () => ({
  id: "miosa-1",
  state: "running",
  templateId: "miosa-sandbox",
  data: { id: "miosa-1", state: "running", boot_path: "created" },
  exec: {
    run: jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    stream: jest.fn(),
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
      MIOSA_TEMPLATE_ID: "miosa-sandbox",
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
        name: expect.stringMatching(/^hackerai-[a-f0-9]{24}$/),
        templateId: "miosa-sandbox",
        persistent: true,
        idleTimeoutSec: 420,
        waitUntilReady: true,
        externalUserId: expect.stringMatching(/^hackerai-[a-f0-9]{24}$/),
      }),
    );
    expect(sdkSandbox.exec.run).toHaveBeenCalledWith(
      expect.stringContaining("mkdir -p /home/user/upload"),
      { timeoutSec: 10 },
    );
    expect(setSandbox).toHaveBeenCalledWith(result.sandbox);
    expect(onBoot).toHaveBeenCalledWith(
      expect.objectContaining({ path: "create_fresh", create_attempts: 1 }),
    );
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
    expect(sdkSandbox.exec.stream).toHaveBeenCalledWith("example", {
      cwd: "/home/user",
      timeoutSec: 2,
    });
    expect(onStdout).toHaveBeenCalledWith("hello\n");
    expect(onStderr).toHaveBeenCalledWith("warning\n");
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
      expect.stringContaining("nohup bash -lc 'npm run dev'"),
      { cwd: "/home/user" },
    );
  });
});
