import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Subscription } from "centrifuge";
import { trackPresenceTraffic } from "../presence-traffic";

jest.mock("node:crypto", () => ({ randomUUID: jest.fn() }));
const context = {
  source: "presence-route" as const,
  userId: "user",
  connectionId: "conn",
};

describe("presence traffic", () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest
      .mocked(randomUUID)
      .mockReturnValue("00000000-0000-4000-8000-000000000000");
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("counts reconnects and UTF-8 fanout without recording content, and completes only once", () => {
    const sub = new EventEmitter();
    const otherListener = jest.fn();
    sub.on("publication", otherListener);
    const finish = trackPresenceTraffic(sub as Subscription, context);
    sub.emit("subscribed", {});
    sub.emit("publication", {
      data: { data: "秘密", command: "private command", token: "secret-token" },
    });
    sub.emit("subscribed", {});
    sub.emit("publication", { data: { content: "private file" } });
    finish(false);
    finish(true);
    sub.emit("publication", { data: { data: "after cleanup" } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      sample_rate: 8,
      presence_reliable: false,
      received_publications: 2,
      received_payload_bytes_estimate: 128 * 2 + 6 + 15 + 12,
      subscription_events: 2,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /秘密|private command|private file|secret-token/,
    );
    expect(sub.listenerCount("publication")).toBe(1);
    expect(otherListener).toHaveBeenCalledTimes(3);
    expect(sub.listenerCount("subscribed")).toBe(0);
  });

  it("keeps every large probe even when its ID is outside the small-probe sample", () => {
    jest
      .mocked(randomUUID)
      .mockReturnValue("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const sub = new EventEmitter();
    const finish = trackPresenceTraffic(sub as Subscription, context);
    sub.emit("publication", { data: { data: "x".repeat(1024 * 1024) } });
    finish(true);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      sample_rate: 1,
      received_payload_bytes_estimate: 1024 * 1024 + 128,
    });
  });

  it("samples small probes and removes observers even when no log is emitted", () => {
    jest
      .mocked(randomUUID)
      .mockReturnValue("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const sub = new EventEmitter();
    const finish = trackPresenceTraffic(sub as Subscription, context);
    finish(true);
    expect(log).not.toHaveBeenCalled();
    expect(sub.eventNames()).toEqual([]);
  });
});
