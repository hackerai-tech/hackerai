const mockStopAll = jest.fn();
const mockConfirmProcessTermination = jest.fn().mockResolvedValue(true);

jest.mock("../process-runner", () => ({
  ProcessRunner: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    stopAll: mockStopAll,
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
};

describe("LocalSandboxClient cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirmProcessTermination.mockResolvedValue(true);
  });

  it("stops process resources exactly once across repeated cleanup", async () => {
    const client = new LocalSandboxClient(config);

    await Promise.all([client.cleanup(), client.cleanup()]);

    expect(mockStopAll).toHaveBeenCalledTimes(1);
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

  it("acknowledges cancellation when the streamed command already exited", async () => {
    const client = new LocalSandboxClient(config);
    const publishToChannel = jest.fn().mockResolvedValue(undefined);
    const privateClient = client as unknown as {
      handleCommandCancel: (message: {
        type: "command_cancel";
        commandId: string;
        targetConnectionId: string;
      }) => Promise<void>;
      publishToChannel: typeof publishToChannel;
    };
    privateClient.publishToChannel = publishToChannel;

    await privateClient.handleCommandCancel({
      type: "command_cancel",
      commandId: "command-already-gone",
      targetConnectionId: "connection-1",
    });

    expect(mockConfirmProcessTermination).not.toHaveBeenCalled();
    expect(publishToChannel).toHaveBeenCalledWith({
      type: "command_cancel_result",
      commandId: "command-already-gone",
      canceled: true,
    });
  });

  it("reports an injected exit handler without exiting the process", async () => {
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

  it("does not report readiness before relay subscription", async () => {
    let relayStarted!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      relayStarted = resolve;
    });
    let markRelayReady!: () => void;
    const relayReady = new Promise<void>((resolve) => {
      markRelayReady = resolve;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const client = new LocalSandboxClient(config);
    (
      client as unknown as {
        convexHttp: { mutation: jest.Mock };
      }
    ).convexHttp.mutation = jest.fn().mockResolvedValue({
      success: true,
      userId: "user-1",
      connectionId: "connection-1",
      centrifugoToken: "relay-token",
      centrifugoWsUrl: "wss://relay.example.test/connection/websocket",
    });
    (
      client as unknown as {
        setupCentrifugo: () => Promise<void>;
      }
    ).setupCentrifugo = jest.fn(async () => {
      relayStarted();
      await relayReady;
    });
    (
      client as unknown as {
        startIdleCheck: () => void;
      }
    ).startIdleCheck = jest.fn();

    const start = client.start();
    await setupStarted;
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(
      "Local sandbox is ready",
    );

    markRelayReady();
    await start;
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Local sandbox is ready",
    );
    logSpy.mockRestore();
  });
});
