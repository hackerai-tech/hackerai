import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("convex/values", () => ({
  v: new Proxy({}, { get: () => () => ({}) }),
  ConvexError: class ConvexError extends Error {
    constructor(readonly data: { code: string; message: string }) {
      super(data.message);
    }
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "service-key") throw new Error("Unauthorized");
  },
}));

const steers = require("../agentSteers") as typeof import("../agentSteers");
const { deleteAgentSteersForChat } =
  require("../lib/agentSteers") as typeof import("../lib/agentSteers");

type Row = Record<string, unknown> & { _id: string };

function fixture(user = "owner") {
  let nextId = 0;
  const rows: Record<string, Row[]> = {
    chats: [
      {
        _id: "chat-row",
        id: "chat",
        user_id: "owner",
        active_trigger_run_id: "run-1",
      },
      { _id: "other-chat-row", id: "other-chat", user_id: "someone-else" },
    ],
    agent_steers: [],
  };
  const select = (table: string, equals: Record<string, unknown>) =>
    rows[table].filter((row) =>
      Object.entries(equals).every(([field, value]) => row[field] === value),
    );
  const ctx = {
    auth: {
      getUserIdentity: async () => (user ? { subject: user } : null),
    },
    db: {
      query: (table: string) => ({
        withIndex: (
          _name: string,
          build: (q: {
            eq: (field: string, value: unknown) => unknown;
          }) => void,
        ) => {
          const equals: Record<string, unknown> = {};
          const q = {
            eq(field: string, value: unknown) {
              equals[field] = value;
              return q;
            },
          };
          build(q);
          return {
            first: async () => select(table, equals)[0] ?? null,
            take: async (count: number) =>
              select(table, equals).slice(0, count),
          };
        },
      }),
      insert: async (table: string, value: Record<string, unknown>) => {
        rows[table].push({ _id: `steer-row-${++nextId}`, ...value });
      },
      patch: async (id: string, value: Record<string, unknown>) => {
        const row = Object.values(rows)
          .flat()
          .find((entry) => entry._id === id);
        if (!row) throw new Error("missing row");
        Object.assign(row, value);
      },
      delete: async (id: string) => {
        for (const table of Object.keys(rows))
          rows[table] = rows[table].filter((row) => row._id !== id);
      },
    },
  };
  const create = (id: string, text = `message ${id}`, chatId = "chat") =>
    steers.create.handler(ctx as never, { chatId, id, text });
  const runArgs = (runId: string, deliveredIds: string[]) => ({
    serviceKey: "service-key",
    userId: "owner",
    chatId: "chat",
    runId,
    deliveredIds,
  });
  const claim = (runId = "run-1", deliveredIds: string[] = []) =>
    steers.claimForBackend.handler(ctx as never, runArgs(runId, deliveredIds));
  const acknowledge = (runId: string, deliveredIds: string[]) =>
    steers.acknowledgeForBackend.handler(
      ctx as never,
      runArgs(runId, deliveredIds),
    );
  const withdraw = (id: string) =>
    steers.withdraw.handler(ctx as never, { chatId: "chat", id });
  return { rows, ctx, create, claim, acknowledge, withdraw };
}

describe("agent steers", () => {
  it("keeps returning a claimed steer until the run confirms receipt", async () => {
    const { create, claim, rows } = fixture();
    expect(await create("a", "  check the login form first  ")).toBe("pending");
    const steer = { id: "a", text: "check the login form first" };
    expect(await claim()).toEqual([steer]);
    // The first response was lost: the next step's claim recovers it.
    expect(await claim()).toEqual([steer]);
    expect(await claim("run-1", ["a"])).toEqual([]);
    expect(rows.agent_steers).toEqual([]);
  });

  it("drops steers a finishing run confirms without claiming new ones", async () => {
    const { create, claim, acknowledge, rows } = fixture();
    await create("a");
    await claim();
    await create("b");
    await acknowledge("run-1", ["a"]);
    expect(rows.agent_steers.map((row) => row.id)).toEqual(["b"]);
    expect(rows.agent_steers[0].claimed_at).toBeUndefined();
  });

  it("does not hand a steer to a run that is not the chat's active run", async () => {
    const { create, claim, rows } = fixture();
    await create("a");
    expect(await claim("run-old")).toEqual([]);
    // The run that replaced the target cannot read another run's steer.
    rows.chats[0].active_trigger_run_id = "run-2";
    expect(await claim("run-2")).toEqual([]);
    expect(rows.agent_steers).toHaveLength(1);
  });

  it("lets either the run or a withdrawal take a steer, never both", async () => {
    const claimedFirst = fixture();
    await claimedFirst.create("a");
    await claimedFirst.claim();
    expect(await claimedFirst.withdraw("a")).toEqual({
      outcome: "not_found",
    });

    const withdrawnFirst = fixture();
    await withdrawnFirst.create("a", "use the staging host");
    expect(await withdrawnFirst.withdraw("a")).toEqual({
      outcome: "withdrawn",
      text: "use the staging host",
    });
    expect(await withdrawnFirst.claim()).toEqual([]);
  });

  it("returns a steer the ended run claimed but never confirmed", async () => {
    const { create, claim, withdraw, rows, ctx } = fixture();
    await create("a", "also check X");
    await claim();
    rows.chats[0].active_trigger_run_id = undefined;
    const pending = await steers.listPending.handler(ctx as never, {
      chatId: "chat",
    });
    expect(pending).toEqual([
      expect.objectContaining({ id: "a", claimed: true }),
    ]);
    expect(await withdraw("a")).toEqual({
      outcome: "withdrawn",
      text: "also check X",
    });
  });

  it("asks the client to queue when no run is active", async () => {
    const { create, rows } = fixture();
    rows.chats[0].active_trigger_run_id = undefined;
    expect(await create("a")).toBe("no_active_run");
    expect(rows.agent_steers).toEqual([]);
  });

  it("rejects steers into another user's chat and other users' withdrawals", async () => {
    const { create } = fixture();
    await expect(create("a", "text", "other-chat")).rejects.toThrow(
      "Chat not found",
    );

    const owner = fixture();
    await owner.create("a");
    const intruder = fixture("intruder");
    intruder.rows.agent_steers = owner.rows.agent_steers;
    expect(await intruder.withdraw("a")).toEqual({ outcome: "not_found" });
    expect(owner.rows.agent_steers).toHaveLength(1);
  });

  it("returns pending steers oldest first and caps how many can wait", async () => {
    const { create, ctx } = fixture();
    const now = jest.spyOn(Date, "now");
    for (let index = 0; index < 10; index++) {
      now.mockReturnValue(1_000 - index);
      await create(`s${index}`);
    }
    await expect(create("overflow")).rejects.toThrow(
      "Wait for the Agent to read your earlier messages.",
    );
    now.mockRestore();
    const pending = await steers.listPending.handler(ctx as never, {
      chatId: "chat",
    });
    expect(pending.map((steer) => steer.id).slice(0, 2)).toEqual(["s9", "s8"]);
  });

  it("removes unread steers when the chat is deleted", async () => {
    const { create, ctx, rows } = fixture();
    await create("a");
    await create("b");
    await deleteAgentSteersForChat(ctx as never, "chat");
    expect(rows.agent_steers).toEqual([]);
  });
});
