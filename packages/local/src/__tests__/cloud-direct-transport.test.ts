import { EventEmitter } from "events";
import type WebSocket from "ws";

import { CloudDirectTransport } from "../cloud-direct-transport";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
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

describe("CloudDirectTransport", () => {
  it("routes correlated output only to the socket that owns the command", async () => {
    const transport = new CloudDirectTransport();
    const onMessage = jest.fn();
    const onDisconnect = jest.fn();
    transport.start({ onMessage, onDisconnect });
    const owner = new FakeSocket();
    const other = new FakeSocket();
    transport.accept(owner as unknown as WebSocket);
    transport.accept(other as unknown as WebSocket);

    owner.receive({
      type: "command",
      commandId: "command-1",
      command: "id",
      targetConnectionId: "microvm-1",
    });
    other.receive({
      type: "command_cancel",
      commandId: "command-1",
      targetConnectionId: "microvm-1",
    });
    await transport.publish({
      type: "command_cancel_result",
      commandId: "command-1",
      canceled: false,
    });
    await transport.publish({
      type: "stdout",
      commandId: "command-1",
      data: "uid=1000",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(owner.sent).toContainEqual({
      type: "stdout",
      commandId: "command-1",
      data: "uid=1000",
    });
    expect(owner.sent).toContainEqual({
      type: "command_cancel_result",
      commandId: "command-1",
      canceled: false,
    });
    expect(other.sent).not.toContainEqual(
      expect.objectContaining({ commandId: "command-1" }),
    );

    owner.close();
    await Promise.resolve();
    expect(onDisconnect).toHaveBeenCalledWith({
      commandIds: ["command-1"],
      sessionIds: [],
    });
    await transport.stop();
  });

  it("answers transport heartbeats without dispatching a command", () => {
    const transport = new CloudDirectTransport();
    const onMessage = jest.fn();
    transport.start({ onMessage, onDisconnect: jest.fn() });
    const socket = new FakeSocket();
    transport.accept(socket as unknown as WebSocket);

    socket.receive({ type: "transport_ping", nonce: "heartbeat-1" });

    expect(socket.sent).toContainEqual({
      type: "transport_pong",
      nonce: "heartbeat-1",
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("routes file acknowledgements only to the requesting socket", async () => {
    const transport = new CloudDirectTransport();
    const onMessage = jest.fn();
    transport.start({ onMessage, onDisconnect: jest.fn() });
    const owner = new FakeSocket();
    const other = new FakeSocket();
    transport.accept(owner as unknown as WebSocket);
    transport.accept(other as unknown as WebSocket);

    owner.receive({
      type: "file_write",
      requestId: "file-1",
      path: "/home/user/transcript.json",
      content: "e30=",
      isBase64: true,
      allowedRoot: "/home/user",
      targetConnectionId: "microvm-1",
    });
    other.receive({
      type: "file_append",
      requestId: "file-1",
      path: "/home/user/transcript.json",
      content: "Cg==",
      isBase64: true,
      allowedRoot: "/home/user",
      targetConnectionId: "microvm-1",
    });
    await transport.publish({ type: "file_ok", requestId: "file-1" });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(owner.sent).toContainEqual({
      type: "file_ok",
      requestId: "file-1",
    });
    expect(other.sent).not.toContainEqual(
      expect.objectContaining({ requestId: "file-1" }),
    );
    await transport.stop();
  });
});
