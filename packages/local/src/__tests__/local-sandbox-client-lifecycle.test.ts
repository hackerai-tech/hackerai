const mockShutdown = jest.fn().mockResolvedValue(undefined);
const mockDispose = jest.fn();
const mockConfirmProcessTermination = jest.fn().mockResolvedValue(true);

jest.mock("../process-runner", () => ({
  ProcessRunner: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    shutdown: mockShutdown,
    dispose: mockDispose,
  })),
  isPtyAvailable: () => true,
}));

jest.mock("../command-cancellation", () => ({
  confirmProcessTermination: (...args: unknown[]) =>
    mockConfirmProcessTermination(...args),
  isProcessTreeTerminationConfirmed: () => true,
}));

import { LocalSandboxClient } from "../index";

const config = {
  convexUrl: "http://127.0.0.1:3210",
  token: "test-token",
  name: "test",
  authMode: "cloud" as const,
  cloudSessionId: "test-session",
  microvmId: "test-microvm",
};

describe("LocalSandboxClient in-process cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShutdown.mockResolvedValue(undefined);
    mockConfirmProcessTermination.mockResolvedValue(true);
  });

  it("disposes process resources exactly once across repeated cleanup", async () => {
    const client = new LocalSandboxClient(config);

    await Promise.all([client.cleanup(), client.cleanup()]);

    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it("allows a later lifecycle hook to retry failed process cleanup", async () => {
    mockShutdown
      .mockRejectedValueOnce(new Error("PTY still running"))
      .mockResolvedValueOnce(undefined);
    const client = new LocalSandboxClient(config);

    await expect(client.cleanup()).rejects.toThrow("PTY still running");
    await expect(client.cleanup()).resolves.toBeUndefined();

    expect(mockShutdown).toHaveBeenCalledTimes(2);
  });

  it("waits for streamed-command termination confirmation", async () => {
    let confirmTermination!: (confirmed: boolean) => void;
    mockConfirmProcessTermination.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirmTermination = resolve;
        }),
    );
    const client = new LocalSandboxClient(config);
    const proc = {
      pid: 1234,
      exitCode: null,
      signalCode: null,
      kill: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
    (
      client as unknown as {
        activeStreamCommands: Map<string, typeof proc>;
      }
    ).activeStreamCommands.set("command-1", proc);

    let settled = false;
    const cleanup = client.cleanup().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    confirmTermination(true);
    await cleanup;
    expect(mockConfirmProcessTermination).toHaveBeenCalledTimes(1);
  });

  it("reports a lifecycle fatal without exiting the lifecycle process", async () => {
    const onExitRequested = jest.fn();
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const client = new LocalSandboxClient(config, { onExitRequested });

    (
      client as unknown as {
        requestExit: (code: number, error: Error) => void;
      }
    ).requestExit(1, new Error("relay failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onExitRequested).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "relay failed" }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("preserves the standalone CLI default exit behavior", async () => {
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const client = new LocalSandboxClient(config);

    (
      client as unknown as {
        requestExit: (code: number, error: Error) => void;
      }
    ).requestExit(1, new Error("relay failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
