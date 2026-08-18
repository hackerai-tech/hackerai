const mockSpawn = jest.fn();

jest.mock(
  "node-pty",
  () => ({
    spawn: (...args: unknown[]) => mockSpawn(...args),
  }),
  { virtual: true },
);

import { ProcessRunner } from "../process-runner";

type ExitListener = (event: { exitCode?: number }) => void;

const makePtyProcess = () => {
  let exitListener: ExitListener | undefined;
  return {
    pid: 1234,
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    onData: jest.fn(),
    onExit: jest.fn((listener: ExitListener) => {
      exitListener = listener;
    }),
    __exit: (exitCode = 0) => exitListener?.({ exitCode }),
  };
};

describe("ProcessRunner cleanup", () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
    mockSpawn.mockReset();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("treats ESRCH during stop as an already-stopped process", () => {
    const proc = makePtyProcess();
    proc.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    mockSpawn.mockReturnValue(proc);

    const runner = new ProcessRunner();
    runner.run("session-1", "echo hi");

    expect(runner.stop("session-1")).toBe(false);
    expect(runner.isRunning("session-1")).toBe(false);
    runner.dispose();
  });

  it("retains tracking until PTY exit is confirmed after SIGKILL", async () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);

    const runner = new ProcessRunner();
    runner.run("session-1", "sleep 10");

    const shutdown = runner.shutdown();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(runner.isRunning("session-1")).toBe(true);
    proc.__exit();
    await jest.advanceTimersByTimeAsync(25);
    await shutdown;
    expect(runner.isRunning("session-1")).toBe(false);
  });

  it("catches unexpected SIGKILL errors during escalation", () => {
    const proc = makePtyProcess();
    proc.kill.mockImplementation((signal?: string) => {
      if (signal === "SIGKILL") {
        throw new Error("permission denied");
      }
    });
    mockSpawn.mockReturnValue(proc);
    const errorListener = jest.fn();

    const runner = new ProcessRunner();
    runner.on("error", errorListener);
    runner.run("session-1", "sleep 10");

    expect(runner.stop("session-1")).toBe(true);
    expect(() => jest.advanceTimersByTime(5_000)).not.toThrow();

    expect(errorListener).toHaveBeenCalledWith("session-1", expect.any(Error));
    proc.__exit();
    runner.dispose();
  });

  it("rejects shutdown when a SIGKILL-resistant PTY never exits", async () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "trap '' TERM; sleep 10");

    const shutdown = expect(runner.shutdown()).rejects.toThrow(
      "Timed out terminating 1 PTY process",
    );
    await jest.advanceTimersByTimeAsync(7_000);

    await shutdown;
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    proc.__exit();
    runner.dispose();
  });

  it("preserves the first SIGKILL deadline when shutdown is retried", async () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    runner.run("session-1", "sleep 10");

    expect(runner.stop("session-1")).toBe(true);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(runner.stop("session-1")).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(3, "SIGKILL");
    proc.__exit();
    runner.dispose();
  });
});
