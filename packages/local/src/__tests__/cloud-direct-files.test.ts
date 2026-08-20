import { EventEmitter } from "events";
import { mkdtemp, readFile, rm, stat, symlink } from "fs/promises";
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

async function createDirectFileHarness(): Promise<{
  allowedRoot: string;
  client: LocalSandboxClient;
  socket: FakeSocket;
}> {
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
  await client.start();
  transport.accept(socket as unknown as WebSocket);
  return { allowedRoot, client, socket };
}

async function sendFileMutation(
  socket: FakeSocket,
  message: Record<string, unknown> & { requestId: string },
): Promise<Record<string, unknown>> {
  const response = waitForResponse(socket, message.requestId);
  socket.receive({ ...message, targetConnectionId: "microvm-files" });
  return response;
}

describe("direct cloud file mutations", () => {
  it("writes and appends a transcript larger than the process argument limit", async () => {
    const { allowedRoot, client, socket } = await createDirectFileHarness();
    const targetPath = join(allowedRoot, "transcripts", "large.json");
    const transcript = Buffer.from(
      JSON.stringify({ messages: [{ content: "x".repeat(256 * 1024) }] }),
    );
    const first = transcript.subarray(0, 128 * 1024);
    const second = transcript.subarray(128 * 1024);

    try {
      const firstResponse = sendFileMutation(socket, {
        type: "file_write",
        requestId: "write-1",
        path: targetPath,
        content: first.toString("base64"),
        isBase64: true,
        allowedRoot,
      });
      await expect(firstResponse).resolves.toMatchObject({
        type: "file_ok",
        requestId: "write-1",
      });

      const secondResponse = sendFileMutation(socket, {
        type: "file_append",
        requestId: "append-1",
        path: targetPath,
        content: second.toString("base64"),
        isBase64: true,
        allowedRoot,
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

  it("rejects unsafe paths and malformed file content", async () => {
    const { allowedRoot, client, socket } = await createDirectFileHarness();
    const outsideRoot = await mkdtemp(
      join(tmpdir(), "hackerai-direct-files-outside-"),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const targetSymlink = join(allowedRoot, "target-link.json");
    const parentSymlink = join(allowedRoot, "parent-link");
    await symlink(join(outsideRoot, "target.json"), targetSymlink);
    await symlink(outsideRoot, parentSymlink, "dir");

    const rejectedRequests = [
      {
        type: "file_write",
        requestId: "outside-root",
        path: join(outsideRoot, "outside.json"),
        content: "e30=",
        isBase64: true,
        allowedRoot,
      },
      {
        type: "file_write",
        requestId: "target-symlink",
        path: targetSymlink,
        content: "e30=",
        isBase64: true,
        allowedRoot,
      },
      {
        type: "file_write",
        requestId: "missing-root",
        path: join(allowedRoot, "missing-root.json"),
        content: "e30=",
        isBase64: true,
      },
      {
        type: "file_write",
        requestId: "invalid-base64",
        path: join(allowedRoot, "invalid-base64.json"),
        content: "not-canonical-base64",
        isBase64: true,
        allowedRoot,
      },
      {
        type: "file_write",
        requestId: "parent-symlink",
        path: join(parentSymlink, "created", "outside.json"),
        content: "e30=",
        isBase64: true,
        allowedRoot,
      },
    ];

    try {
      for (const request of rejectedRequests) {
        await expect(sendFileMutation(socket, request)).resolves.toMatchObject({
          type: "file_error",
          requestId: request.requestId,
        });
      }
      await expect(
        stat(join(outsideRoot, "outside.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(outsideRoot, "created"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      errorSpy.mockRestore();
      await client.cleanup();
      await Promise.all([
        rm(allowedRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
