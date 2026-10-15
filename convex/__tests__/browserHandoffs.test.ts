import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("convex/values", () => ({
  v: new Proxy({}, { get: () => () => ({}) }),
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: () => undefined }));

const browser =
  require("../browserHandoffs") as typeof import("../browserHandoffs");
type Row = Record<string, unknown> & { _id: string };

function fixture() {
  const rows: Record<string, Row[]> = {
    chats: [
      {
        _id: "chat-row",
        id: "chat",
        user_id: "owner",
        active_trigger_run_id: "run-parent",
      },
    ],
    subagent_runs: [
      {
        _id: "child-row",
        subagent_id: "child",
        user_id: "owner",
        chat_id: "chat",
        trigger_run_id: "run-child",
        status: "running",
      },
    ],
    browser_handoffs: [],
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    db: {
      query: (table: string) => ({
        withIndex: (
          _name: string,
          select: (q: {
            eq: (field: string, value: unknown) => unknown;
          }) => unknown,
        ) => {
          const equals: Record<string, unknown> = {};
          const q = {
            eq(field: string, value: unknown) {
              equals[field] = value;
              return q;
            },
          };
          select(q);
          const selected = () =>
            rows[table].filter((row) =>
              Object.entries(equals).every(
                ([field, value]) => row[field] === value,
              ),
            );
          return {
            first: async () => selected()[0] ?? null,
            order: (_direction: string) => ({
              first: async () => selected().at(-1) ?? null,
              take: async (count: number) => selected().slice(-count).reverse(),
            }),
          };
        },
      }),
      insert: async (table: string, value: Record<string, unknown>) => {
        rows[table].push({ _id: `row-${rows[table].length + 1}`, ...value });
      },
      patch: async (id: string, value: Record<string, unknown>) => {
        const row = Object.values(rows)
          .flat()
          .find((entry) => entry._id === id);
        if (!row) throw new Error("missing row");
        Object.assign(row, value);
      },
    },
  };
  const scope = {
    serviceKey: "key",
    userId: "owner",
    sessionId: "a".repeat(32),
  };
  const register = (
    agentId = "parent",
    runId = "run-parent",
    sessionId = scope.sessionId,
  ) =>
    browser.registerForBackend.handler(ctx as never, {
      serviceKey: "key",
      sessionId,
      userId: "owner",
      chatId: "chat",
      runId,
      agentId,
      sandboxId: "sandbox",
      directory: "/dev/shm/hackerai-browser-0123456789abcdef01234567",
      expiresAt: Date.now() + 60_000,
    });
  return { rows, ctx, scope, register };
}

describe("browser handoff ownership", () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it("registers only the active owner and keeps sandbox details private", async () => {
    const { ctx, rows, register, scope } = fixture();
    expect(await register()).toBe(true);
    const publicRow = await browser.getForUser.handler(ctx as never, {
      chatId: "chat",
      agentId: "parent",
    });
    expect(publicRow?.sessionId).toBe(scope.sessionId);
    expect(JSON.stringify(publicRow)).not.toMatch(/sandbox|directory|dev\/shm/);
    expect(
      await browser.getForBackend.handler(ctx as never, {
        ...scope,
        userId: "other",
      }),
    ).toBeNull();
    rows.chats[0].active_trigger_run_id = "other-run";
    expect(await browser.getForBackend.handler(ctx as never, scope)).toBeNull();
    expect(await register("parent", "old-run", "b".repeat(32))).toBe(false);
  });

  it("isolates child and parent run records", async () => {
    const { ctx, rows, register, scope } = fixture();
    expect(await register()).toBe(true);
    expect(await register("child", "run-child", "c".repeat(32))).toBe(true);
    expect(rows.browser_handoffs).toHaveLength(2);
    rows.subagent_runs[0].status = "canceled";
    expect(
      await browser.getForBackend.handler(ctx as never, {
        ...scope,
        sessionId: "c".repeat(32),
      }),
    ).toBeNull();
    expect(
      await browser.getForBackend.handler(ctx as never, scope),
    ).not.toBeNull();
  });

  it("rejects replayed and expired control grants while keeping recovery paused", async () => {
    const { ctx, register, scope } = fixture();
    await register();
    const grant = "g".repeat(43);
    expect(
      await browser.beginTakeoverForBackend.handler(ctx as never, {
        ...scope,
        grant,
      }),
    ).toBe(true);
    expect(
      await browser.finishTakeoverForBackend.handler(ctx as never, {
        ...scope,
        grant,
        browserSessionName: "alice",
      }),
    ).toBe(true);
    expect(
      await browser.assertGrantForBackend.handler(ctx as never, {
        ...scope,
        grant: "wrong".repeat(10),
        renew: true,
      }),
    ).toBe(false);
    expect(
      await browser.assertGrantForBackend.handler(ctx as never, {
        ...scope,
        grant,
        renew: true,
      }),
    ).toBe(true);
    expect(
      await browser.releaseForBackend.handler(ctx as never, {
        ...scope,
        grant,
      }),
    ).toBe(true);
    expect(
      await browser.assertGrantForBackend.handler(ctx as never, {
        ...scope,
        grant,
        renew: false,
      }),
    ).toBe(false);
    expect(
      (await browser.getForBackend.handler(ctx as never, scope))?.state,
    ).toBe("recovery");
  });

  it("cannot resume while input is in flight and revokes input before Agent release", async () => {
    const { ctx, register, scope } = fixture();
    await register();
    const grant = "g".repeat(43);
    await browser.beginTakeoverForBackend.handler(ctx as never, {
      ...scope,
      grant,
    });
    await browser.finishTakeoverForBackend.handler(ctx as never, {
      ...scope,
      grant,
      browserSessionName: "alice",
    });
    expect(
      await browser.beginInputForBackend.handler(ctx as never, {
        ...scope,
        grant,
        inputId: "input-123456789012345",
      }),
    ).toBe(true);
    expect(
      await browser.beginResumeForBackend.handler(ctx as never, {
        ...scope,
        grant,
      }),
    ).toBe(false);
    await browser.finishInputForBackend.handler(ctx as never, {
      ...scope,
      inputId: "input-123456789012345",
    });
    expect(
      await browser.beginResumeForBackend.handler(ctx as never, {
        ...scope,
        grant,
      }),
    ).toBe(true);
    expect(
      await browser.assertGrantForBackend.handler(ctx as never, {
        ...scope,
        grant,
        renew: false,
      }),
    ).toBe(false);
    expect(
      await browser.finishResumeForBackend.handler(ctx as never, scope),
    ).toBe(true);
    expect(
      (await browser.getForBackend.handler(ctx as never, scope))?.state,
    ).toBe("agent");
  });
});
