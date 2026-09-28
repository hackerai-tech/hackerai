import { EventEmitter } from "node:events";
import type { NextRequest } from "next/server";
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
import { randomUUID } from "node:crypto";

jest.mock("node:crypto", () => ({
  ...jest.requireActual("node:crypto"),
  randomUUID: jest.fn(),
}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: jest.fn().mockResolvedValue("user"),
}));
jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("test-token"),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { warn: jest.fn(), error: jest.fn() },
}));
const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("convex/browser", () => ({
  ConvexHttpClient: jest.fn(() => ({
    query: mockQuery,
    mutation: mockMutation,
  })),
}));
const mockSubs: MockSubscription[] = [];
class MockSubscription extends EventEmitter {
  subscribe = jest.fn();
  unsubscribe = jest.fn();
  presence = jest.fn();
}
const mockDisconnect = jest.fn();
jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn(() => ({
    newSubscription: () => {
      const sub = new MockSubscription();
      mockSubs.push(sub);
      return sub;
    },
    connect: jest.fn(),
    disconnect: mockDisconnect,
  })),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@e2b/code-interpreter", () => ({ Sandbox: class {} }));
import { HybridSandboxManager } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";
import { GET } from "../route";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe.each(["presence-route", "sandbox-manager"] as const)(
  "%s traffic lifecycle",
  (source) => {
    const begin = async () => {
      const response =
        source === "presence-route"
          ? GET({} as NextRequest)
          : new HybridSandboxManager("user", jest.fn(), "one", "test-key")
              .listConnections()
              .then((connections) => ({
                status: 200,
                json: async () => ({
                  onlineCount: connections.filter(
                    (c) => c.connectionId === "one",
                  ).length,
                }),
              }));
      await flush();
      return { response };
    };
    let log: jest.SpyInstance;
    const savedEnv = { ...process.env };
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockSubs.length = 0;
      process.env.CENTRIFUGO_WS_URL =
        "wss://relay.example.com/connection/websocket";
      process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
      process.env.CONVEX_SERVICE_ROLE_KEY = "test-key";
      jest
        .mocked(randomUUID)
        .mockReturnValue("00000000-0000-4000-8000-000000000000");
      mockQuery.mockResolvedValue(
        ["one", "two"].map((connectionId) => ({
          connectionId,
          lastSeen: Date.now(),
        })),
      );
      log = jest.spyOn(console, "log").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      process.env = { ...savedEnv };
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("counts fanout after one presence reply while another is still pending", async () => {
      const { response } = await begin();
      mockSubs[0].presence.mockResolvedValue({
        clients: { local: { connInfo: { connectionId: "one" } } },
      });
      mockSubs[0].emit("subscribed", {});
      await flush();
      mockSubs[0].emit("publication", { data: { data: "incidental" } });
      expect(log).not.toHaveBeenCalled();
      mockSubs[1].presence.mockResolvedValue({ clients: {} });
      mockSubs[1].emit("subscribed", {});
      expect((await (await response).json()).onlineCount).toBe(1);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        source,
        connection_id: "one",
        received_publications: 1,
        received_payload_bytes_estimate: 138,
        presence_reliable: true,
      });
      expect(mockMutation).not.toHaveBeenCalled();
      for (const sub of mockSubs) {
        expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
        expect(sub.eventNames()).toEqual([]);
      }
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each(["timeout", "subscription-error", "presence-error"])(
      "cleans up counters and all pending timers on %s without sweeping connections",
      async (failure) => {
        const { response } = await begin();
        mockSubs[0].emit("publication", { data: { content: "private" } });
        if (failure === "timeout")
          await jest.advanceTimersByTimeAsync(
            source === "presence-route" ? 5000 : 2000,
          );
        else if (failure === "subscription-error")
          mockSubs[0].emit("error", { error: { message: "unavailable" } });
        else {
          mockSubs[0].presence.mockRejectedValue(new Error("unavailable"));
          mockSubs[0].emit("subscribed", {});
        }
        expect((await response).status).toBe(200);
        expect(log).toHaveBeenCalledTimes(2);
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
          received_publications: 1,
          presence_reliable: false,
        });
        expect(mockMutation).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        for (const sub of mockSubs) expect(sub.eventNames()).toEqual([]);
      },
    );
  },
);
