jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: class MockSandbox {},
}));

const mockConvexQuery = jest.fn();
const mockConvexMutation = jest.fn();

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: mockConvexQuery,
    mutation: mockConvexMutation,
  }),
}));

import {
  filterConnectionsByPresence,
  HybridSandboxManager,
  LOCAL_SANDBOX_PRESENCE_GRACE_MS,
} from "../hybrid-sandbox-manager";
import {
  getConnectionIdFromPresenceClient,
  presenceHasConnectionId,
} from "@/lib/centrifugo/presence";
import type { ConnectionInfo } from "../sandbox-types";

const baseConnection: ConnectionInfo = {
  connectionId: "conn-online",
  name: "Local",
  lastSeen: 1_000,
  isDesktop: false,
  capabilities: { commands: true, pty: true },
};

const makeConnection = (
  overrides: Partial<ConnectionInfo>,
): ConnectionInfo => ({
  ...baseConnection,
  ...overrides,
});

describe("filterConnectionsByPresence", () => {
  it("keeps online connections even when their heartbeat is old", () => {
    const now = 100_000;
    const connections = [
      makeConnection({ connectionId: "conn-online", lastSeen: 1 }),
    ];

    const result = filterConnectionsByPresence(
      connections,
      new Set(["conn-online"]),
      now,
    );

    expect(result.availableConnections).toEqual(connections);
    expect(result.staleConnections).toEqual([]);
  });

  it("keeps recently seen connections during the presence grace window", () => {
    const now = 100_000;
    const recentLastSeen = now - LOCAL_SANDBOX_PRESENCE_GRACE_MS + 1;
    const connections = [
      makeConnection({ connectionId: "conn-recent", lastSeen: recentLastSeen }),
    ];

    const result = filterConnectionsByPresence(connections, new Set(), now);

    expect(result.availableConnections).toEqual(connections);
    expect(result.staleConnections).toEqual([]);
  });

  it("filters connections that are absent from presence after the grace window", () => {
    const now = 100_000;
    const staleLastSeen = now - LOCAL_SANDBOX_PRESENCE_GRACE_MS - 1;
    const stale = makeConnection({
      connectionId: "conn-stale",
      lastSeen: staleLastSeen,
    });
    const live = makeConnection({
      connectionId: "conn-live",
      lastSeen: staleLastSeen,
    });

    const result = filterConnectionsByPresence(
      [stale, live],
      new Set(["conn-live"]),
      now,
    );

    expect(result.availableConnections).toEqual([live]);
    expect(result.staleConnections).toEqual([stale]);
  });
});

describe("presenceHasConnectionId", () => {
  it("ignores the backend probe subscriber when it has no connection info", () => {
    expect(
      presenceHasConnectionId(
        {
          clients: {
            "probe-client": {
              client: "probe-client",
              user: "user-1",
            },
          },
        },
        "conn-stale",
      ),
    ).toBe(false);
  });

  it("matches the local sandbox connection from Centrifugo connInfo", () => {
    expect(
      presenceHasConnectionId(
        {
          clients: {
            "probe-client": {
              client: "probe-client",
              user: "user-1",
            },
            "sandbox-client": {
              client: "sandbox-client",
              user: "user-1",
              connInfo: { connectionId: "conn-live" },
            },
          },
        },
        "conn-live",
      ),
    ).toBe(true);
  });

  it("supports legacy presence info field names", () => {
    expect(
      getConnectionIdFromPresenceClient({
        info: { connectionId: "conn-legacy" },
      }),
    ).toBe("conn-legacy");
  });
});

describe("HybridSandboxManager browser automation prompt", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConvexQuery.mockReset();
    mockConvexMutation.mockReset();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("uses a cmd-compatible browser probe for Windows local contexts", async () => {
    mockConvexQuery.mockResolvedValue([
      makeConnection({
        connectionId: "desktop-conn",
        name: "Desktop",
        isDesktop: true,
        osInfo: {
          platform: "win32",
          arch: "x86_64",
          release: "11",
          hostname: "windows-box",
        },
      }),
    ]);

    const manager = new HybridSandboxManager(
      "user-1",
      jest.fn(),
      "desktop",
      "service-key",
      null,
      "pro",
    );

    const context = await manager.getSandboxContextForPrompt();

    expect(context).toContain("where agent-browser && agent-browser --version");
    expect(context).not.toContain("command -v agent-browser");
  });
});
