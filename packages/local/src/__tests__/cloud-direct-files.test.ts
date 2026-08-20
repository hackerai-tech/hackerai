import { EventEmitter } from "events";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type WebSocket from "ws";

import { CloudDirectTransport } from "../cloud-direct-transport";
import { LocalSandboxClient } from "../index";

jest.mock("../process-runner", () => ({
  ProcessRunner: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
  })),
  isPtyAvailable: () => true,
}));

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string, callback?: (error?: Error) => void): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.emit("sent", message);
    callback?.();
  }

  close(code = 1000): void {
    this.readyState = this.CLOSED;
    queueMicrotask(() => this.emit("close", code));
  }

  terminate(): void {
    this.close(1006);
  }

  receive(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

function waitForResponse(
  socket: FakeSocket,
  requestId: string,
): Promise<Record<string, unknown>> {
  const existing = socket.sent.find(
    (message) => message.requestId === requestId,
  );
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const onSent = (message: Record<string, unknown>) => {
      if (message.requestId !== requestId) return;
      socket.off("sent", onSent);
      resolve(message);
    };
    socket.on("sent", onSent);
  });
}

describe("direct cloud file mutations", () => {
  it("writes and appends a transcript larger than the process argument limit", async () => {
    const allowedRoot = await mkdtemp(join(tmpdir(), "hackerai-direct-files-"));
    const transport = new CloudDirectTransport();
    const client = new LocalSandboxClient(
      {
        convexUrl: "http://127.0.0.1",
        token: "direct-cloud",
        name: "AWS Lambda MicroVM",
        authMode: "direct-cloud",
        cloudSessionId: "session-files",
        microvmId: "microvm-files",
      },
      { directTransport: transport },
    );
    const socket = new FakeSocket();
    const targetPath = join(allowedRoot, "transcripts", "large.json");
    const transcript = Buffer.from(
      JSON.stringify({ messages: [{ content: "x".repeat(256 * 1024) }] }),
    );
    const first = transcript.subarray(0, 128 * 1024);
    const second = transcript.subarray(128 * 1024);

    try {
      await client.start();
      transport.accept(socket as unknown as WebSocket);

      const firstResponse = waitForResponse(socket, "write-1");
      socket.receive({
        type: "file_write",
        requestId: "write-1",
        path: targetPath,
        content: first.toString("base64"),
        isBase64: true,
        allowedRoot,
        targetConnectionId: "microvm-files",
      });
      await expect(firstResponse).resolves.toMatchObject({
        type: "file_ok",
        requestId: "write-1",
      });

      const secondResponse = waitForResponse(socket, "append-1");
      socket.receive({
        type: "file_append",
        requestId: "append-1",
        path: targetPath,
        content: second.toString("base64"),
        isBase64: true,
        allowedRoot,
        targetConnectionId: "microvm-files",
      });
      await expect(secondResponse).resolves.toMatchObject({
        type: "file_ok",
        requestId: "append-1",
      });

      await expect(readFile(targetPath)).resolves.toEqual(transcript);
    } finally {
      await client.cleanup();
      await rm(allowedRoot, { recursive: true, force: true });
    }
  });
});
