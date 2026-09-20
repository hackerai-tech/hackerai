import { webcrypto } from "node:crypto";

jest.mock("../_generated/server", () => ({
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
  listConnections,
  resolveEnvironmentPreference,
} from "../localSandbox";

const environmentId = "cafecafe-1234-4123-8123-abcdefabcdef";
// Exercise the actual handlers against a small indexed database fixture.
function fixture() {
  const rows: Record<string, any[]> = {
    local_sandbox_tokens: [{ token: "test-token", user_id: "user-a" }],
    local_sandbox_connections: [],
  };
  let user: string | null = "user-a";
  const db = {
    query: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const chain: any = {
        withIndex: (_index: string, filter: (builder: any) => unknown) => {
          const builder: any = {
            eq: (key: string, value: unknown) => {
              filters.push([key, value]);
              return builder;
            },
          };
          filter(builder);
          return chain;
        },
        collect: async () =>
          rows[table].filter((row) =>
            filters.every(([key, value]) => row[key] === value),
          ),
        first: async () => (await chain.collect())[0] ?? null,
        unique: async () => (await chain.collect())[0] ?? null,
      };
      return chain;
    },
    insert: async (table: string, row: any) => {
      const id = `row-${rows[table].length}`;
      rows[table].push({ ...row, _id: id, _creationTime: rows[table].length });
      return id;
    },
    patch: async (id: string, patch: any) =>
      Object.assign(
        rows.local_sandbox_connections.find((row) => row._id === id),
        patch,
      ),
  };
  return {
    ctx: {
      db,
      auth: { getUserIdentity: async () => (user ? { subject: user } : null) },
    },
    rows,
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
