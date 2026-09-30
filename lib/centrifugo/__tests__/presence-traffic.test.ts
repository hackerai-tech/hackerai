import { EventEmitter } from "node:events";
import type { Subscription } from "centrifuge";
import { trackPresenceTraffic } from "../presence-traffic";
import { recordRelayReceivedBytes } from "../traffic";

jest.mock("../traffic", () => ({
  ...jest.requireActual("../traffic"),
  recordRelayReceivedBytes: jest.fn(),
}));

afterEach(() => jest.clearAllMocks());

test("records UTF-8 incidental presence traffic once and removes only its observer", () => {
  const sub = new EventEmitter();
  const otherListener = jest.fn();
  sub.on("publication", otherListener);
  const finish = trackPresenceTraffic(sub as Subscription, "presence-route");
  sub.emit("publication", {
    data: { data: "秘密", command: "private command", token: "secret-token" },
  });
  sub.emit("publication", { data: { content: "private file" } });
  finish();
  finish();
  sub.emit("publication", { data: { data: "after cleanup" } });
  const bytes = 128 * 2 + 6 + 15 + 12;
  expect(recordRelayReceivedBytes).toHaveBeenCalledTimes(1);
  expect(recordRelayReceivedBytes).toHaveBeenCalledWith(
    "presence",
    "presence-route",
    bytes,
    bytes,
  );
  expect(
    JSON.stringify(jest.mocked(recordRelayReceivedBytes).mock.calls),
  ).not.toMatch(/秘密|private command|private file|secret-token/);
  expect(sub.listenerCount("publication")).toBe(1);
  expect(otherListener).toHaveBeenCalledTimes(3);
});

test("records every probe without random sampling or a subscription-event observer", () => {
  const sub = new EventEmitter();
  const finish = trackPresenceTraffic(sub as Subscription, "sandbox-manager");
  sub.emit("publication", { data: { data: "x".repeat(1024 * 1024) } });
  finish();
  expect(recordRelayReceivedBytes).toHaveBeenCalledWith(
    "presence",
    "sandbox-manager",
    1024 * 1024 + 128,
    1024 * 1024 + 128,
  );
  expect(sub.eventNames()).toEqual([]);
});
