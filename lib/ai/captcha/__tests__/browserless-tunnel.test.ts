/** @jest-environment-options {"customExportConditions":["node","node-addons"]} */
import { createServer } from "node:net";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { bridgeBrowserlessSocket } from "../browserless-tunnel";

it("carries real CDP WebSocket frames while rejecting provider account commands", async () => {
  const provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(provider, "listening");
  const received: string[] = [];
  provider.on("connection", (socket) =>
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message.method);
      socket.send(
        JSON.stringify({ id: message.id, result: { title: "demo page" } }),
      );
    }),
  );
  const address = provider.address();
  if (typeof address === "string") throw new Error();
  const remote = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(remote, "open");
  let bridge: ReturnType<typeof bridgeBrowserlessSocket> | undefined;
  const stopped = jest.fn();
  const tunnel = createServer((socket) => {
    bridge = bridgeBrowserlessSocket(
      remote,
      (bytes) =>
        new Promise((resolve, reject) => {
          socket.write(bytes, (error) => (error ? reject(error) : resolve()));
        }),
      () => {
        stopped();
        socket.destroy();
      },
    );
    socket.on("data", (bytes) => bridge!.receive(bytes));
    socket.on("close", () => bridge?.close());
  });
  tunnel.listen(0, "127.0.0.1");
  await once(tunnel, "listening");
  const localAddress = tunnel.address();
  if (!localAddress || typeof localAddress === "string") throw new Error();
  const client = new WebSocket(`ws://127.0.0.1:${localAddress.port}/`);
  try {
    await once(client, "open");
    const reply = once(client, "message");
    client.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "document.title" },
      }),
    );
    expect(JSON.parse((await reply)[0].toString())).toEqual({
      id: 1,
      result: { title: "demo page" },
    });
    for (const method of [
      "Browserless.reconnect",
      "Browser.getBrowserCommandLine",
      "Target.sendMessageToTarget",
    ]) {
      const denied = once(client, "message");
      client.send(
        JSON.stringify({
          id: 2,
          method,
          params: {
            message: JSON.stringify({ id: 3, method: "Browserless.reconnect" }),
          },
        }),
      );
      expect(JSON.parse((await denied)[0].toString()).error.code).toBe(-32601);
    }
    expect(received).toEqual(["Runtime.evaluate"]);
    bridge!.close();
    expect(stopped).toHaveBeenCalledTimes(1);
  } finally {
    client.terminate();
    bridge?.close();
    remote.terminate();
    for (const socket of provider.clients) socket.terminate();
    provider.close();
    tunnel.close();
  }
}, 10000);
