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
  let dataListener: ((data: string) => void) | undefined;
  return {
    pid: 1234,
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    onData: jest.fn((listener: (data: string) => void) => {
      dataListener = listener;
    }),
    onExit: jest.fn((listener: ExitListener) => {
      exitListener = listener;
    }),
    __exit: (exitCode = 0) => exitListener?.({ exitCode }),
    __data: (data: string) => dataListener?.(data),
  };
};

describe("ProcessRunner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("has no flush timer while idle and batches from the first output chunk", () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    expect(jest.getTimerCount()).toBe(0);
    runner.run("session-1", "echo hi");
    proc.__data("");
    jest.advanceTimersByTime(1_000);
    expect(jest.getTimerCount()).toBe(0);

    proc.__data("hello");
    jest.advanceTimersByTime(10);
    proc.__data(" world");
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(5);
    expect(onData).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onData).toHaveBeenCalledWith("session-1", "hello world");
    expect(jest.getTimerCount()).toBe(0);

    proc.__data(" again");
    jest.advanceTimersByTime(16);
    expect(onData).toHaveBeenNthCalledWith(2, "session-1", " again");
    expect(jest.getTimerCount()).toBe(0);
    proc.__exit();
    runner.dispose();
  });

  it("flushes threshold output immediately without delaying another session", () => {
    const first = makePtyProcess();
    const second = makePtyProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    runner.run("first", "echo first");
    runner.run("second", "echo second");
    first.__data("a");
    second.__data("b");
    const largeChunk = "x".repeat(32 * 1024);
    jest.advanceTimersByTime(8);
    first.__data(largeChunk);
    expect(onData).toHaveBeenCalledWith("first", "a" + largeChunk);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(8);
    expect(onData).toHaveBeenNthCalledWith(2, "second", "b");
    expect(jest.getTimerCount()).toBe(0);
    second.__data("c");
    second.__data(largeChunk);
    expect(onData).toHaveBeenNthCalledWith(3, "second", "c" + largeChunk);
    expect(jest.getTimerCount()).toBe(0);
    first.__exit();
    second.__exit();
    runner.dispose();
  });

  it("delivers the final buffered output before exit and cancels its timer", () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const events: string[] = [];
    runner.on("data", (_sessionId, data) => events.push(data));
    runner.on("exit", (_sessionId, code) => events.push(`exit:${code}`));
    runner.run("session-1", "echo hi");
    proc.__data("last chunk");
    proc.__exit(3);
    expect(events).toEqual(["last chunk", "exit:3"]);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(1_000);
    expect(events).toHaveLength(2);
    runner.dispose();
  });

  it("keeps another session's pending batch when a session exits early", () => {
    const first = makePtyProcess();
    const second = makePtyProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const runner = new ProcessRunner();
    const events: string[] = [];
    runner.on("data", (id, data) => events.push(`${id}:${data}`));
    runner.on("exit", (id) => events.push(`${id}:exit`));
    runner.run("first", "echo first");
    runner.run("second", "echo second");
    first.__data("final");
    second.__data("pending");
    jest.advanceTimersByTime(8);
    first.__exit();
    expect(events).toEqual(["first:final", "first:exit"]);
    jest.advanceTimersByTime(8);
    expect(events).toEqual(["first:final", "first:exit", "second:pending"]);
    expect(jest.getTimerCount()).toBe(0);
    second.__exit();
    runner.dispose();
  });

  it("does not starve continuous output or lose text across batching boundaries", () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const chunks: string[] = [];
    runner.on("data", (_id, data) => chunks.push(data));
    runner.run("session-1", "stream output");
    const input = [
      "\u001b[",
      "31m",
      "\ud83d",
      "\udd12",
      "é",
      "\r",
      "done",
      "\u001b[0m",
    ];
    for (const chunk of input) {
      proc.__data(chunk);
      jest.advanceTimersByTime(4);
    }
    // A debounce reset on every chunk would never deliver until output stops.
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(input.join(""));
    proc.__data("last");
    proc.__exit();
    expect(chunks.join("")).toBe(input.join("") + "last");
    expect(jest.getTimerCount()).toBe(0);
    runner.dispose();
  });

  it("keeps delivering output after a shutdown timeout until exit is confirmed", async () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    runner.run("session-1", "long command");
    const shutdown = expect(runner.shutdown(50)).rejects.toThrow(
      "Timed out terminating 1 PTY process",
    );
    await jest.advanceTimersByTimeAsync(50);
    await shutdown;
    proc.__data("still alive");
    await jest.advanceTimersByTimeAsync(16);
    expect(onData).toHaveBeenCalledWith("session-1", "still alive");
    expect(runner.isRunning("session-1")).toBe(true);
    proc.__data("final");
    proc.__exit();
    await runner.shutdown();
    expect(onData).toHaveBeenNthCalledWith(2, "session-1", "final");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not restart flush timers after disposal and still flushes on exit", () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    runner.run("session-1", "echo hi");
    proc.__data("before");
    runner.dispose();
    expect(jest.getTimerCount()).toBe(1); // SIGKILL escalation only
    proc.__data(" after");
    jest.advanceTimersByTime(16);
    expect(onData).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    proc.__exit();
    expect(onData).toHaveBeenCalledWith("session-1", "before after");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("delivers buffered output during shutdown and leaves no timers after exit", async () => {
    const proc = makePtyProcess();
    mockSpawn.mockReturnValue(proc);
    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    runner.run("session-1", "echo hi");
    proc.__data("before shutdown");
    const shutdown = runner.shutdown();
    await jest.advanceTimersByTimeAsync(16);
    expect(onData).toHaveBeenCalledWith("session-1", "before shutdown");
    proc.__data("final output");
    proc.__exit();
    expect(onData).toHaveBeenNthCalledWith(2, "session-1", "final output");
    await jest.advanceTimersByTimeAsync(25);
    await shutdown;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("treats ESRCH during stop as an already-stopped process", () => {
    const proc = makePtyProcess();
    proc.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    mockSpawn.mockReturnValue(proc);

    const runner = new ProcessRunner();
    const onData = jest.fn();
    runner.on("data", onData);
    runner.run("session-1", "echo hi");
    proc.__data("last chunk");

    expect(runner.stop("session-1")).toBe(false);
    expect(onData).toHaveBeenCalledWith("session-1", "last chunk");
    expect(jest.getTimerCount()).toBe(0);
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
