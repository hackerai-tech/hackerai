const mockStopAll = jest.fn();
const mockConfirmProcessTermination = jest.fn().mockResolvedValue(true);
const mockSpawn = jest.fn();

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../environment-identity", () => ({
  getEnvironmentId: jest.fn().mockResolvedValue("test-environment"),
}));

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

jest.mock("../private-artifact-hardening", () => ({
  hardenExistingTerminalArtifacts: jest.fn().mockResolvedValue(true),
}));

import { LocalSandboxClient } from "../index";
import { EventEmitter } from "events";

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

  it("decodes base64 command stdin before starting the process", async () => {
    const client = new LocalSandboxClient(config);
    const streamCommand = jest.fn().mockResolvedValue(undefined);
    const privateClient = client as unknown as {
      handleCommand: (message: Record<string, unknown>) => Promise<void>;
      streamCommand: typeof streamCommand;
    };
    privateClient.streamCommand = streamCommand;

    await privateClient.handleCommand({
      type: "command",
      commandId: "command-with-stdin",
      command: "cat >/tmp/private-record",
      stdin: Buffer.from("private evidence").toString("base64"),
      stdinEncoding: "base64",
      targetConnectionId: "connection-1",
      displayName: "",
    });

    expect(streamCommand).toHaveBeenCalledWith(
      "command-with-stdin",
      "cat >/tmp/private-record",
      undefined,
      false,
      "cat >/tmp/private-record",
      Buffer.from("private evidence"),
    );
  });

  it.each([
    { displayName: undefined, shown: true, label: "echo test" },
    { displayName: "Custom label", shown: true, label: "Custom label" },
    { displayName: "", shown: false, label: "echo test" },
  ])(
    "preserves execution and display overrides: $displayName",
    async ({ displayName, shown, label }) => {
      const client = new LocalSandboxClient(config);
      const streamCommand = jest.fn().mockResolvedValue(undefined);
      const privateClient = client as unknown as {
        handleCommand: (message: Record<string, unknown>) => Promise<void>;
        streamCommand: typeof streamCommand;
      };
      privateClient.streamCommand = streamCommand;
      const command =
        'export PATH="$HOME/go/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/local/go/bin:$PATH" && echo test';
      await privateClient.handleCommand({
        type: "command",
        commandId: "display-test",
        command,
        displayName,
        targetConnectionId: "connection-1",
      });
      expect(streamCommand).toHaveBeenCalledWith(
        "display-test",
        command,
        undefined,
        shown,
        label,
        undefined,
      );
    },
  );

  it.each([
    ["SIGTERM", true],
    ["SIGINT", true],
    ["SIGKILL", true],
    ["SIGSEGV", false],
    ["SIGABRT", false],
  ])(
    "distinguishes stop from crash for %s without changing the exit response",
    async (signal, stopped) => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValueOnce(proc);
      const client = new LocalSandboxClient(config);
      const publish = jest.fn().mockResolvedValue(undefined);
      const privateClient = client as unknown as {
        streamCommand: (
          id: string,
          command: string,
          timeout: number,
          show: boolean,
          label: string,
        ) => Promise<void>;
        publishToChannel: typeof publish;
      };
      privateClient.publishToChannel = publish;
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        const running = privateClient.streamCommand(
          "signal-test",
          "test-command",
          0,
          true,
          "Test command",
        );
        proc.emit("close", null, signal);
        await running;
        const output = log.mock.calls.flat().join("\n");
        expect(output).toContain(signal);
        expect(output).toContain(
          stopped ? "Stopped: Test command" : "✗ Test command",
        );
        if (!stopped) expect(output).not.toContain("Stopped:");
        expect(publish).toHaveBeenCalledWith({
          type: "exit",
          commandId: "signal-test",
          exitCode: 1,
        });
      } finally {
        log.mockRestore();
      }
    },
  );

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
    const mutation = jest.fn().mockResolvedValue({
      success: true,
      userId: "user-1",
      connectionId: "connection-1",
      centrifugoToken: "relay-token",
      centrifugoWsUrl: "wss://relay.example.test/connection/websocket",
    });
    (
      client as unknown as {
        convexHttp: { mutation: jest.Mock };
      }
    ).convexHttp.mutation = mutation;
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
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith(
      "localSandbox:connect",
      expect.objectContaining({
        environmentId: "test-environment",
        capabilities: expect.objectContaining({ commandStdin: true }),
      }),
    );
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(
      "Local sandbox is ready",
    );

    markRelayReady();
    await start;
    expect(mutation).toHaveBeenNthCalledWith(2, "localSandbox:ready", {
      token: config.token,
      connectionId: "connection-1",
    });
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Local sandbox is ready",
    );
    logSpy.mockRestore();
  });
});
