import { isUserDeletionFenced } from "../lib/userDeletionFence";
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: jest.fn(async () => false),
}));
import { begin, finish, get } from "../cloudNetwork";
import { validateServiceKey } from "../lib/utils";
import { assertUserCanAccessChatHistory } from "../lib/suspensionGuards";
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (x: unknown) => x,
  query: (x: unknown) => x,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
const call = (fn: any, ctx: any, args: any) => fn.handler(ctx, args);
const auth = { serviceKey: "test", userId: "owner" };
const policy = { mode: "offline", allow: [] };
let rows: any[];
let ctx: any;
beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  ctx = {
    db: {
      query: () => ({
        withIndex: (_: string, build: any) => {
          let userId: string;
          build({
            eq: (_key: string, value: string) => {
              userId = value;
            },
          });
          return {
            unique: async () => rows.find((r) => r.user_id === userId) ?? null,
          };
        },
      }),
      insert: async (_: string, value: any) =>
        rows.push({ ...value, _id: rows.length + 1 }),
      patch: async (id: number, value: any) =>
        Object.assign(
          rows.find((r) => r._id === id),
          value,
        ),
    },
  };
});
it("serializes provider updates, checks revisions, and rejects stale completions", async () => {
  await call(begin, ctx, {
    ...auth,
    token: "first",
    policy,
    expectedRevision: 0,
  });
  await expect(
    call(begin, ctx, { ...auth, token: "second", policy, expectedRevision: 1 }),
  ).rejects.toThrow("already running");
  await expect(
    call(finish, ctx, { ...auth, token: "wrong", success: true }),
  ).rejects.toThrow("ownership changed");
  await call(finish, ctx, { ...auth, token: "first", success: true });
  await expect(
    call(begin, ctx, { ...auth, token: "second", policy, expectedRevision: 0 }),
  ).rejects.toThrow("changed");
  expect(await call(get, ctx, auth)).toEqual({
    policy,
    revision: 1,
    status: "ready",
  });
});
it("retains desired restrictions and the fence after failure, then permits recovery", async () => {
  jest.useFakeTimers();
  try {
    await call(begin, ctx, {
      ...auth,
      token: "first",
      policy,
      expectedRevision: 0,
    });
    await call(finish, ctx, { ...auth, token: "first", success: false });
    expect(await call(get, ctx, auth)).toMatchObject({
      policy,
      status: "failed",
    });
    await expect(call(begin, ctx, { ...auth, token: "retry" })).rejects.toThrow(
      "already running",
    );
    jest.advanceTimersByTime(120_001);
    expect(await call(begin, ctx, { ...auth, token: "retry" })).toMatchObject({
      policy,
      revision: 1,
    });
    await expect(
      call(finish, ctx, { ...auth, token: "first", success: true }),
    ).rejects.toThrow("ownership changed");
  } finally {
    jest.useRealTimers();
  }
});
it("does not expose or change another user's settings", async () => {
  await call(begin, ctx, {
    ...auth,
    token: "first",
    policy,
    expectedRevision: 0,
  });
  expect(await call(get, ctx, { ...auth, userId: "other" })).toBeNull();
  expect(validateServiceKey).toHaveBeenCalledWith("test");
  expect(assertUserCanAccessChatHistory).toHaveBeenCalledWith(ctx, "other");
});

it("allows immediate retry after failure before any provider write while retaining the desired policy", async () => {
  await call(begin, ctx, {
    ...auth,
    token: "first",
    policy,
    expectedRevision: 0,
  });
  await call(finish, ctx, {
    ...auth,
    token: "first",
    success: false,
    releaseLease: true,
  });
  expect(await call(get, ctx, auth)).toMatchObject({
    policy,
    revision: 1,
    status: "failed",
  });
  expect(await call(begin, ctx, { ...auth, token: "retry" })).toMatchObject({
    policy,
    revision: 1,
  });
  await expect(
    call(finish, ctx, { ...auth, token: "first", success: true }),
  ).rejects.toThrow("ownership changed");
});

it("keeps the proxy on network-only edits and rejects new writes once account deletion starts", async () => {
  const proxy = {
    address: "proxy.test:1080",
    authenticated: true,
    revision: "secret-revision",
  };
  await call(begin, ctx, {
    ...auth,
    token: "first",
    policy,
    proxy,
    expectedRevision: 0,
  });
  await call(finish, ctx, { ...auth, token: "first", success: true });
  await call(begin, ctx, {
    ...auth,
    token: "second",
    policy,
    expectedRevision: 1,
  });
  expect(await call(get, ctx, auth)).toMatchObject({
    proxy,
    proxyManaged: true,
    revision: 2,
  });
  await call(finish, ctx, { ...auth, token: "second", success: true });
  jest.mocked(isUserDeletionFenced).mockResolvedValueOnce(true);
  await expect(
    call(begin, ctx, { ...auth, token: "third", policy, expectedRevision: 2 }),
  ).rejects.toThrow("deletion");
});

it("clears the Vault cleanup marker only after owned successful removal and preserves explicit proxy removal", async () => {
  await call(begin, ctx, {
    ...auth,
    token: "setup",
    policy,
    proxy: { address: "proxy.test:1080", authenticated: false, revision: "r" },
    expectedRevision: 0,
  });
  await call(finish, ctx, {
    ...auth,
    token: "setup",
    success: true,
    proxyRemoved: true,
  });
  expect((await call(get, ctx, auth)).proxyManaged).toBe(true);
  await call(begin, ctx, {
    ...auth,
    token: "remove",
    policy,
    proxy: null,
    expectedRevision: 1,
  });
  await call(finish, ctx, {
    ...auth,
    token: "remove",
    success: false,
    releaseLease: true,
    proxyRemoved: true,
  });
  expect((await call(get, ctx, auth)).proxyManaged).toBe(true);
  await call(begin, ctx, { ...auth, token: "retry" });
  await call(finish, ctx, {
    ...auth,
    token: "retry",
    success: true,
    proxyRemoved: true,
  });
  const saved = await call(get, ctx, auth);
  expect(saved.proxy).toBeNull();
  expect(saved.proxyManaged).toBeFalsy();
  expect(
    await call(begin, ctx, {
      ...auth,
      token: "ordinary",
      policy,
      expectedRevision: 2,
    }),
  ).not.toHaveProperty("proxyManaged", true);
});
