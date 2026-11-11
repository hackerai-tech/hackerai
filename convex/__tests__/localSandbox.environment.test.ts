import { webcrypto } from "node:crypto";

jest.mock("../lib/serviceFunctions", () => ({
  query: (definition: unknown) => definition,
  mutation: (definition: unknown) => definition,
  internalMutation: (definition: unknown) => definition,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("jose", () => ({
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return "test-jwt";
    }
  },
}));

import {
  connect,
  connectDesktop,
  ready,
  regenerateToken,
  listConnections,
  listConnectionDetails,
  getConnectionHeartbeats,
  listConnectionsForBackend,
  heartbeatDesktop,
  refreshCentrifugoTokenDesktop,
  refreshCentrifugoToken,
  disconnectDesktop,
  purgeStaleDisconnectedConnections,
  resolveEnvironmentPreference,
} from "../localSandbox";

const environmentId = "cafecafe-1234-4123-8123-abcdefabcdef";
// Exercise the actual handlers against a small indexed database fixture.
function fixture() {
  const rows: Record<string, any[]> = {
    local_sandbox_tokens: [
      { _id: "token-1", token: "test-token", user_id: "user-a" },
    ],
    local_sandbox_connections: [],
    local_sandbox_heartbeats: [],
  };
  const readTables: string[] = [];
  let user: string | null = "user-a";
  const db = {
    query: (table: string) => {
      readTables.push(table);
      const filters: Array<[string, unknown]> = [];
      let cutoff: [string, number] | undefined;
      const chain: any = {
        withIndex: (_index: string, filter: (builder: any) => unknown) => {
          const builder: any = {
            lt: (key: string, value: number) => {
              cutoff = [key, value];
              return builder;
            },
            eq: (key: string, value: unknown) => {
              filters.push([key, value]);
              return builder;
            },
          };
          filter(builder);
          return chain;
        },
        collect: async () =>
          rows[table].filter(
            (row) =>
              filters.every(([key, value]) => row[key] === value) &&
              (!cutoff || row[cutoff[0]] < cutoff[1]),
          ),
        order: () => chain,
        take: async (n: number) => (await chain.collect()).slice(0, n),
        first: async () => (await chain.collect())[0] ?? null,
        unique: async () => (await chain.collect())[0] ?? null,
      };
      return chain;
    },
    insert: async (table: string, row: any) => {
      const id = `${table}-${rows[table].length}`;
      rows[table].push({ ...row, _id: id, _creationTime: rows[table].length });
      return id;
    },
    delete: async (id: string) => {
      for (const table of Object.keys(rows))
        rows[table] = rows[table].filter((r) => r._id !== id);
    },
    patch: async (id: string, patch: any) =>
      Object.assign(
        Object.values(rows)
          .flat()
          .find((row) => row._id === id),
        patch,
      ),
  };
  return {
    ctx: {
      db,
      auth: { getUserIdentity: async () => (user ? { subject: user } : null) },
    },
    rows,
    readTables,
    setUser: (next: string | null) => {
      user = next;
    },
  };
}

const handler = (fn: unknown) =>
  (fn as { handler: (ctx: any, args: any) => Promise<any> }).handler;

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalWsUrl = process.env.CENTRIFUGO_WS_URL;
const originalTokenSecret = process.env.CENTRIFUGO_TOKEN_SECRET;
afterAll(() => {
  if (originalCrypto)
    Object.defineProperty(globalThis, "crypto", originalCrypto);
  if (originalWsUrl === undefined) delete process.env.CENTRIFUGO_WS_URL;
  else process.env.CENTRIFUGO_WS_URL = originalWsUrl;
  if (originalTokenSecret === undefined)
    delete process.env.CENTRIFUGO_TOKEN_SECRET;
  else process.env.CENTRIFUGO_TOKEN_SECRET = originalTokenSecret;
});
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
  process.env.CENTRIFUGO_WS_URL = "ws://relay.test";
  process.env.CENTRIFUGO_TOKEN_SECRET = "test-signing-key";
});

it("keeps one environment across fresh sessions and exposes it only after relay readiness", async () => {
  const { ctx, rows } = fixture();
  const args = {
    token: "test-token",
    connectionName: "machine",
    clientVersion: "test",
    environmentId,
  };
  const first = await handler(connect)(ctx, args);
  expect(await handler(listConnections)(ctx, {})).toEqual([]);
  await handler(ready)(ctx, {
    token: args.token,
    connectionId: first.connectionId,
  });
  const second = await handler(connect)(ctx, args);
  expect(second.connectionId).not.toBe(first.connectionId);
  expect(
    rows.local_sandbox_connections.map((row) => row.environment_id),
  ).toEqual([environmentId, environmentId]);
  expect(
    (await handler(listConnections)(ctx, {})).map(
      (row: any) => row.connectionId,
    ),
  ).toEqual([first.connectionId]);
  await handler(ready)(ctx, {
    token: args.token,
    connectionId: second.connectionId,
  });
  expect(
    await handler(resolveEnvironmentPreference)(ctx, {
      preference: first.connectionId,
    }),
  ).toBe(`environment:${environmentId}`);
});

it("keeps old clients usable and never maps another account's session", async () => {
  const { ctx, setUser } = fixture();
  const old = await handler(connect)(ctx, {
    token: "test-token",
    connectionName: "legacy",
    clientVersion: "old",
  });
  expect((await handler(listConnections)(ctx, {}))[0].connectionId).toBe(
    old.connectionId,
  );
  expect(
    await handler(resolveEnvironmentPreference)(ctx, {
      preference: old.connectionId,
    }),
  ).toBe(old.connectionId);
  const modern = await handler(connect)(ctx, {
    token: "test-token",
    connectionName: "modern",
    clientVersion: "new",
    environmentId,
  });
  setUser("user-b");
  expect(
    await handler(resolveEnvironmentPreference)(ctx, {
      preference: modern.connectionId,
    }),
  ).toBe(modern.connectionId);
  expect(await handler(listConnections)(ctx, {})).toEqual([]);
  await expect(
    handler(ready)(ctx, {
      token: "invalid",
      connectionId: modern.connectionId,
    }),
  ).rejects.toThrow();
});

it("does not disconnect another desktop environment when a desktop restarts", async () => {
  const { ctx, rows } = fixture();
  const first = await handler(connectDesktop)(ctx, {
    connectionName: "one",
    environmentId,
  });
  const other = await handler(connectDesktop)(ctx, {
    connectionName: "two",
    environmentId: "bbbbbbbb-1234-4123-8123-abcdefabcdef",
  });
  await handler(connectDesktop)(ctx, { connectionName: "one", environmentId });
  expect(
    rows.local_sandbox_connections.find(
      (row) => row.connection_id === first.connectionId,
    ).status,
  ).toBe("disconnected");
  expect(
    rows.local_sandbox_connections.find(
      (row) => row.connection_id === other.connectionId,
    ).status,
  ).toBe("connected");
});

it("invalidates pending as well as ready sessions when the connection token is regenerated", async () => {
  const { ctx, rows } = fixture();
  const args = {
    token: "test-token",
    connectionName: "machine",
    clientVersion: "test",
    environmentId,
  };
  const active = await handler(connect)(ctx, args);
  await handler(ready)(ctx, {
    token: args.token,
    connectionId: active.connectionId,
  });
  await handler(connect)(ctx, args);
  await handler(connectDesktop)(ctx, {
    connectionName: "desktop",
    environmentId,
  });
  expect(rows.local_sandbox_connections.map((row) => row.ready)).toEqual([
    true,
    false,
    false,
  ]);
  await handler(regenerateToken)(ctx, {});
  expect(
    rows.local_sandbox_connections.every(
      (row) =>
        row.status === "disconnected" &&
        row.disconnect_reason === "token_regenerated",
    ),
  ).toBe(true);
  expect(await handler(listConnections)(ctx, {})).toEqual([]);
});

it("round-trips the CLI storage namespace and actual client version", async () => {
  const { ctx } = fixture();
  const capabilities = {
    commands: true,
    pty: false,
    commandStdin: true,
    operationChannels: true,
    privateArtifactNamespace: "uid-1000",
  };
  await handler(connect)(ctx, {
    token: "test-token",
    connectionName: "local",
    clientVersion: "0.8.8",
    capabilities,
  });
  expect(await handler(listConnections)(ctx, {})).toEqual([
    expect.objectContaining({ capabilities }),
  ]);
});

it.each(["../outside", "uid-01", "uid-1000\n"])(
  "rejects invalid private storage namespace %s before registration",
  async (namespace) => {
    const { ctx, rows } = fixture();
    await expect(
      handler(connect)(ctx, {
        token: "test-token",
        connectionName: "local",
        clientVersion: "0.8.8",
        capabilities: {
          commands: true,
          pty: false,
          commandStdin: true,
          privateArtifactNamespace: namespace,
        },
      }),
    ).rejects.toThrow("Invalid private terminal artifact namespace");
    expect(rows.local_sandbox_connections).toHaveLength(0);
  },
);

it("keeps heartbeat churn outside stable list reads while legacy and backend timestamps stay fresh", async () => {
  const { ctx, rows, readTables } = fixture();
  const { connectionId } = await handler(connectDesktop)(ctx, {
    connectionName: "desktop",
    environmentId,
  });
  expect(await handler(listConnectionDetails)(ctx, {})).toEqual([]);
  const clock = jest.spyOn(Date, "now");
  try {
    clock.mockReturnValue(1000);
    await handler(heartbeatDesktop)(ctx, { connectionId });
    const stableRow = { ...rows.local_sandbox_connections[0] };
    clock.mockReturnValue(2000);
    await handler(heartbeatDesktop)(ctx, { connectionId });
    expect(rows.local_sandbox_connections[0]).toEqual(stableRow);
    expect(rows.local_sandbox_heartbeats).toHaveLength(1);
    readTables.length = 0;
    const details = await handler(listConnectionDetails)(ctx, {});
    expect(details).toEqual([
      expect.objectContaining({ connectionId, isDesktop: true }),
    ]);
    expect(readTables).not.toContain("local_sandbox_heartbeats");
    expect(details[0]).not.toHaveProperty("lastSeen");
    expect(await handler(listConnections)(ctx, {})).toEqual([
      { ...details[0], lastSeen: 2000 },
    ]);
    expect(
      await handler(listConnectionsForBackend)(ctx, {
        serviceKey: "test",
        userId: "user-a",
      }),
    ).toEqual([{ ...details[0], lastSeen: 2000 }]);
    await handler(disconnectDesktop)(ctx, { connectionId });
    expect(await handler(listConnectionDetails)(ctx, {})).toEqual([]);
    clock.mockReturnValue(3000);
    expect(await handler(heartbeatDesktop)(ctx, { connectionId })).toEqual({
      success: false,
    });
    expect(
      await handler(refreshCentrifugoTokenDesktop)(ctx, { connectionId }),
    ).toMatchObject({
      ok: false,
      reason: "connection_inactive",
      msSinceLastHeartbeat: 1000,
    });
    const replacement = await handler(connectDesktop)(ctx, {
      connectionName: "desktop",
      environmentId,
    });
    await handler(heartbeatDesktop)(ctx, {
      connectionId: replacement.connectionId,
    });
    expect(await handler(listConnectionDetails)(ctx, {})).toEqual([
      expect.objectContaining({ connectionId: replacement.connectionId }),
    ]);
  } finally {
    clock.mockRestore();
  }
});

it("preserves legacy fallback, scoped freshness, and anonymous/cross-user denial", async () => {
  const { ctx, rows, readTables, setUser } = fixture();
  const { connectionId } = await handler(connectDesktop)(ctx, {
    connectionName: "legacy",
  });
  const args = { connectionIds: [connectionId, connectionId, "missing"] };
  expect(await handler(getConnectionHeartbeats)(ctx, args)).toEqual([
    {
      connectionId,
      lastSeen: rows.local_sandbox_connections[0].last_heartbeat,
    },
  ]);
  await handler(heartbeatDesktop)(ctx, { connectionId });
  readTables.length = 0;
  expect(
    await handler(getConnectionHeartbeats)(ctx, {
      connectionIds: [connectionId],
    }),
  ).toHaveLength(1);
  expect(readTables).toEqual(["local_sandbox_heartbeats"]);
  setUser("user-b");
  expect(await handler(getConnectionHeartbeats)(ctx, args)).toEqual([]);
  expect(await handler(heartbeatDesktop)(ctx, { connectionId })).toEqual({
    success: false,
  });
  expect(await handler(listConnectionDetails)(ctx, {})).toEqual([]);
  setUser(null);
  expect(await handler(getConnectionHeartbeats)(ctx, args)).toEqual([]);
  expect(await handler(listConnectionDetails)(ctx, {})).toEqual([]);
  await expect(
    handler(heartbeatDesktop)(ctx, { connectionId }),
  ).rejects.toThrow();
});

it("token refresh and repeated CLI readiness update freshness without changing stable metadata", async () => {
  const { ctx, rows } = fixture();
  const { connectionId } = await handler(connect)(ctx, {
    token: "test-token",
    connectionName: "cli",
    clientVersion: "test",
    environmentId,
  });
  const args = { token: "test-token", connectionId };
  await handler(ready)(ctx, args);
  const stable = { ...rows.local_sandbox_connections[0] };
  const clock = jest.spyOn(Date, "now").mockReturnValue(123456);
  try {
    await handler(ready)(ctx, args);
    await handler(refreshCentrifugoToken)(ctx, args);
    expect(rows.local_sandbox_connections[0]).toEqual(stable);
    expect(
      (
        await handler(listConnectionsForBackend)(ctx, {
          userId: "user-a",
          serviceKey: "test",
        })
      )[0].lastSeen,
    ).toBe(123456);
  } finally {
    clock.mockRestore();
  }
});

it("purges heartbeat records with expired connections while retaining active sessions", async () => {
  const { ctx, rows } = fixture();
  const a = await handler(connectDesktop)(ctx, { connectionName: "one" });
  await handler(heartbeatDesktop)(ctx, a);
  const b = await handler(connectDesktop)(ctx, {
    connectionName: "replacement",
  });
  await handler(heartbeatDesktop)(ctx, b);
  expect(
    await handler(purgeStaleDisconnectedConnections)(ctx, {
      cutoffTimeMs: Date.now() + 1,
      limit: 1,
    }),
  ).toEqual({ deletedCount: 1 });
  expect(rows.local_sandbox_heartbeats.map((r) => r.connection_id)).toEqual([
    b.connectionId,
  ]);
  expect(rows.local_sandbox_connections.map((r) => r.connection_id)).toEqual([
    b.connectionId,
  ]);
});
