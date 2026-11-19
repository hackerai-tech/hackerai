import { EventEmitter } from "events";
import type { Centrifuge, Subscription } from "centrifuge";
import { dispatchIsolatedOperation } from "../dispatch-operation";

it("preserves publication and listener cleanup when a dispatch observer throws", async () => {
  const reply = new EventEmitter();
  const control = {
    on: jest.fn(),
    subscribe: jest.fn(),
    ready: jest.fn().mockResolvedValue(undefined),
    presence: jest.fn().mockResolvedValue({
      clients: { client: { connInfo: { connectionId: "connection-id" } } },
    }),
    publish: jest.fn().mockImplementation(async () => {
      reply.emit("publication", {
        data: { type: "operation_ready", commandId: "command-id" },
      });
    }),
    unsubscribe: jest.fn(),
    removeAllListeners: jest.fn(),
  };
  const client = {
    newSubscription: jest.fn().mockReturnValue(control),
    removeSubscription: jest.fn(),
  };
  const observed: string[] = [];
  await dispatchIsolatedOperation(
    client as unknown as Centrifuge,
    "user-id",
    "connection-id",
    { commandId: "command-id" },
    () => true,
    reply as unknown as Subscription,
    undefined,
    (phase) => {
      observed.push(phase);
      throw new Error("diagnostic sink unavailable");
    },
  );
  expect(observed).toEqual([
    "control_ready",
    "presence",
    "publish",
    "operation_ready",
    "ready_received",
  ]);
  expect(control.publish).toHaveBeenCalledTimes(1);
  expect(control.unsubscribe).toHaveBeenCalledTimes(1);
  expect(client.removeSubscription).toHaveBeenCalledWith(control);
  expect(reply.listenerCount("publication")).toBe(0);
});
