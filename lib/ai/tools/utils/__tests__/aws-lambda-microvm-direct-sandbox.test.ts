import { EventEmitter } from "events";
import type WebSocket from "ws";

import { AwsLambdaMicrovmDirectSandbox } from "../aws-lambda-microvm-direct-sandbox";
import { createCentrifugoPtyHandle } from "../centrifugo-pty-adapter";

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  readonly sent: Array<Record<string, unknown>> = [];
  autoCompleteCommands = true;

  send(data: string, callback?: (error?: Error) => void): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    callback?.();
    if (message.type === "command" && this.autoCompleteCommands) {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "stdout",
              commandId: message.commandId,
              data: "direct-ok",
            }),
          ),
        );
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "exit",
              commandId: message.commandId,
              exitCode: 0,
            }),
          ),
        );
      });
    }
    if (message.type === "command_cancel") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "command_cancel_result",
              commandId: message.commandId,
              canceled: true,
            }),
          ),
        );
      });
    }
    if (message.type === "file_write" || message.type === "file_append") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "file_ok",
              requestId: message.requestId,
            }),
          ),
        );
      });
    }
    if (message.type === "pty_create") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "pty_ready",
              sessionId: message.sessionId,
              pid: 4242,
            }),
          ),
        );
      });
    }
    if (message.type === "pty_input") {
      queueMicrotask(() => {
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "pty_data",
              sessionId: message.sessionId,
              data: message.data,
            }),
          ),
        );
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "pty_exit",
              sessionId: message.sessionId,
              exitCode: 0,
            }),
          ),
        );
      });
    }
  }

  close(code = 1000): void {
    this.readyState = this.CLOSED;
    queueMicrotask(() => this.emit("close", code));
  }

  terminate(): void {
    this.close(1006);
  }
}

describe("AwsLambdaMicrovmDirectSandbox", () => {
  it("authenticates to port 9000 and runs commands over one direct socket", async () => {
    const socket = new FakeWebSocket();
    const issueAuthToken = jest.fn().mockResolvedValue("short-lived-jwe");
    const createWebSocket = jest.fn(
      (_endpoint: string, _protocols: string[]) => {
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "transport_ready",
                capabilities: { fileMutations: true },
              }),
            ),
          );
        });
        return socket as unknown as WebSocket;
      },
    );
    const log = jest.fn();
    const sandbox = new AwsLambdaMicrovmDirectSandbox({
      userId: "user-direct",
      sessionId: "session-direct",
      microvmId: "microvm-direct",
      endpoint: "microvm-direct.lambda-microvm.us-east-1.on.aws",
      issueAuthToken,
      log,
      createWebSocket,
    });

    await sandbox.ready();
    expect(createWebSocket).toHaveBeenCalledTimes(1);
    expect(issueAuthToken).toHaveBeenCalledTimes(1);
    const result = await sandbox.commands.run("printf direct-ok", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      stdout: "direct-ok",
      stderr: "",
      exitCode: 0,
      pid: undefined,
    });
    expect(issueAuthToken).toHaveBeenCalledTimes(1);
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://microvm-direct.lambda-microvm.us-east-1.on.aws/sandbox",
      [
        "lambda-microvms",
        "lambda-microvms.authentication.short-lived-jwe",
        "lambda-microvms.port.9000",
      ],
      expect.objectContaining({ maxPayload: 4 * 1024 * 1024 }),
    );
    expect(socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command",
          command: "printf direct-ok",
          targetConnectionId: "microvm-direct",
        }),
      ]),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("short-lived-jwe");

    await sandbox.close();
  });

  it("routes cancellation and PTY traffic over the direct transport", async () => {
    const socket = new FakeWebSocket();
    socket.autoCompleteCommands = false;
    const sandbox = new AwsLambdaMicrovmDirectSandbox({
      userId: "user-direct",
      sessionId: "session-direct",
      microvmId: "microvm-direct",
      endpoint: "https://microvm-direct.example.test",
      issueAuthToken: jest.fn().mockResolvedValue("short-lived-jwe"),
      log: jest.fn(),
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(JSON.stringify({ type: "transport_ready" })),
          );
        });
        return socket as unknown as WebSocket;
      },
    });

    let cancel: (() => Promise<boolean>) | undefined;
    const command = sandbox.commands.run("sleep 30", {
      timeoutMs: 30_000,
      onCancelReady: (readyCancel) => {
        cancel = readyCancel;
      },
    });
    await Promise.resolve();
    expect(cancel).toBeDefined();
    await expect(cancel!()).resolves.toBe(true);
    await expect(command).resolves.toMatchObject({ exitCode: 130 });

    const pty = await createCentrifugoPtyHandle(sandbox, {
      command: "bash",
      cols: 80,
      rows: 24,
    });
    expect(pty.pid).toBe(4242);
    const chunks: string[] = [];
    pty.onData((data) => chunks.push(new TextDecoder().decode(data)));
    await pty.sendInput(new TextEncoder().encode("id\n"));
    await expect(pty.exited).resolves.toEqual({ exitCode: 0 });
    expect(chunks).toEqual(["id\n"]);

    await sandbox.close();
  });

  it("writes large transcripts as bounded native file chunks", async () => {
    const socket = new FakeWebSocket();
    const sandbox = new AwsLambdaMicrovmDirectSandbox({
      userId: "user-direct",
      sessionId: "session-direct",
      microvmId: "microvm-direct",
      endpoint: "https://microvm-direct.example.test",
      issueAuthToken: jest.fn().mockResolvedValue("short-lived-jwe"),
      log: jest.fn(),
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "transport_ready",
                capabilities: { fileMutations: true },
              }),
            ),
          );
        });
        return socket as unknown as WebSocket;
      },
    });
    const transcript = Buffer.from(
      JSON.stringify({ messages: [{ content: "x".repeat(256 * 1024) }] }),
    );
    const transcriptArrayBuffer = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(transcriptArrayBuffer).set(transcript);

    await sandbox.ready();
    await sandbox.files.write("transcripts/large.json", transcriptArrayBuffer);

    const mutations = socket.sent.filter(
      (message) =>
        message.type === "file_write" || message.type === "file_append",
    );
    expect(mutations.length).toBeGreaterThan(1);
    expect(mutations[0]).toMatchObject({
      type: "file_write",
      path: "/home/user/transcripts/large.json",
      allowedRoot: "/home/user",
      targetConnectionId: "microvm-direct",
    });
    expect(mutations.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file_append" }),
      ]),
    );
    expect(
      mutations.every(
        (message) =>
          typeof message.content === "string" &&
          message.content.length <= 48 * 1024,
      ),
    ).toBe(true);
    const reconstructed = Buffer.from(
      mutations.map((message) => message.content).join(""),
      "base64",
    );
    expect(reconstructed.equals(transcript)).toBe(true);
    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "command" }),
    );

    await sandbox.close();
  });

  it("keeps shell writes for older guests without file capabilities", async () => {
    const socket = new FakeWebSocket();
    const sandbox = new AwsLambdaMicrovmDirectSandbox({
      userId: "user-direct",
      sessionId: "session-direct",
      microvmId: "microvm-direct",
      endpoint: "https://microvm-direct.example.test",
      issueAuthToken: jest.fn().mockResolvedValue("short-lived-jwe"),
      log: jest.fn(),
      createWebSocket: () => {
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(JSON.stringify({ type: "transport_ready" })),
          );
        });
        return socket as unknown as WebSocket;
      },
    });

    await sandbox.ready();
    await sandbox.files.write("transcripts/compatible.json", Buffer.from("{}"));

    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: "command" }),
    );
    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "file_write" }),
    );
    await sandbox.close();
  });
});
