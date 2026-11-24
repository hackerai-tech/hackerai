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
const queue =
  require("../queuedMessages") as typeof import("../queuedMessages");
const { retireQueuedMessage } =
  require("../lib/queuedMessages") as typeof import("../lib/queuedMessages");
const { deleteAgentSteersForChat, retireSavedSteers, withoutWithdrawnSteers } =
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
    queued_messages: [],
    agent_goals: [],
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
          const ranges: Array<(row: Row) => boolean> = [];
          // Like Convex, a range only matches rows that have the field.
          const inRange =
            (field: string, test: (value: number) => boolean) => (row: Row) =>
              typeof row[field] === "number" && test(row[field] as number);
          const q = {
            eq(field: string, value: unknown) {
              equals[field] = value;
              return q;
            },
            gte(field: string, value: number) {
              ranges.push(inRange(field, (current) => current >= value));
              return q;
            },
            lt(field: string, value: number) {
              ranges.push(inRange(field, (current) => current < value));
              return q;
            },
          };
          build(q as never);
          const matches = () =>
            select(table, equals).filter((row) =>
              ranges.every((range) => range(row)),
            );
          return {
            first: async () => matches()[0] ?? null,
            take: async (count: number) => matches().slice(0, count),
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
    steers.create.handler(ctx as never, { chatId, id, text, sentAt: 1_000 });
  const claim = (runId = "run-1") =>
    steers.claimForBackend.handler(ctx as never, {
      serviceKey: "service-key",
      userId: "owner",
      chatId: "chat",
      runId,
    });
  const withdraw = (id: string) =>
    steers.withdraw.handler(ctx as never, { chatId: "chat", id });
  const enqueue = (id: string, text = `queued ${id}`, sentAt = 1_000) =>
    queue.enqueue.handler(ctx as never, { chatId: "chat", id, text, sentAt });
  const listQueue = () =>
    queue.list.handler(ctx as never, { chatId: "chat" }) as Promise<
      Array<{ id: string; text: string; fromSteer: boolean }>
    >;
  return { rows, ctx, create, claim, withdraw, enqueue, listQueue };
}

describe("agent steers", () => {
  it("returns a claimed steer again so a lost response cannot lose it", async () => {
    const { create, claim, rows } = fixture();
    expect(await create("a", "  check the login form first  ")).toBe("pending");
    const steer = { id: "a", text: "check the login form first" };
    expect(await claim()).toEqual([steer]);
    expect(await claim()).toEqual([steer]);
    expect(rows.agent_steers).toHaveLength(1);
    expect(rows.agent_steers[0].claimed_at).toEqual(expect.any(Number));
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

  it("returns a steer the ended run claimed but never saved", async () => {
    const { create, claim, withdraw, rows, ctx } = fixture();
    await create("a", "also check X");
    await claim();
    rows.chats[0].active_trigger_run_id = undefined;
    const pending = await steers.listPending.handler(ctx as never, {
      chatId: "chat",
    });
    expect(pending).toEqual([
      expect.objectContaining({ id: "a", sentAt: 1_000 }),
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

  it("retires a steer when a saved response shows it, so it is never queued again", async () => {
    const { create, claim, withdraw, rows, ctx } = fixture();
    await create("a", "use staging");
    await create("b", "also check X");
    await claim();
    await retireSavedSteers(ctx as never, {
      chatId: "chat",
      userId: "owner",
      parts: [
        { type: "text", text: "Switching." },
        {
          type: "data-agent-steer",
          id: "a",
          data: { id: "a", text: "use staging" },
        },
      ],
    });
    rows.chats[0].active_trigger_run_id = undefined;
    expect(await withdraw("a")).toEqual({ outcome: "not_found" });
    expect(await withdraw("b")).toEqual({
      outcome: "withdrawn",
      text: "also check X",
    });
  });

  it("does not retire another user's steer from a saved response", async () => {
    const { create, ctx, rows } = fixture();
    await create("a");
    await retireSavedSteers(ctx as never, {
      chatId: "chat",
      userId: "intruder",
      parts: [
        { type: "data-agent-steer", id: "a", data: { id: "a", text: "x" } },
      ],
    });
    expect(rows.agent_steers).toHaveLength(1);
  });

  it("drops a withdrawn steer from a save that arrives after Stop", async () => {
    const { create, claim, withdraw, rows, ctx } = fixture();
    await create("a", "use staging");
    await claim();
    // Stop cleared the run before its worker saved the response.
    rows.chats[0].active_trigger_run_id = undefined;
    expect(await withdraw("a")).toEqual({
      outcome: "withdrawn",
      text: "use staging",
    });
    const steerPart = {
      type: "data-agent-steer",
      id: "a",
      data: { id: "a", text: "use staging" },
    };
    const saved = await withoutWithdrawnSteers(ctx as never, {
      chatId: "chat",
      userId: "owner",
      parts: [{ type: "text", text: "Partial answer" }, steerPart],
    });
    expect(saved).toEqual([{ type: "text", text: "Partial answer" }]);
    expect(await withdraw("a")).toEqual({ outcome: "not_found" });
  });

  it("clears settled steers after their tombstone expires", async () => {
    const { create, withdraw, rows } = fixture();
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    await create("a");
    rows.chats[0].active_trigger_run_id = undefined;
    await withdraw("a");
    rows.chats[0].active_trigger_run_id = "run-1";
    // Still kept within the Agent run cap, so a late save is still dropped.
    now.mockReturnValue(1_000 + 6 * 60 * 60 * 1000);
    await create("b");
    expect(rows.agent_steers.map((row) => row.id)).toEqual(["a", "b"]);
    now.mockReturnValue(1_000 + 8 * 60 * 60 * 1000);
    await create("c");
    now.mockRestore();
    expect(rows.agent_steers.map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("finds open steers behind a full window of recent settled rows", async () => {
    const { create, claim, rows, ctx } = fixture();
    const now = Date.now();
    for (let index = 0; index < 100; index++)
      rows.agent_steers.push({
        _id: `settled-${index}`,
        id: `settled-${index}`,
        chat_id: "chat",
        user_id: "owner",
        run_id: "run-1",
        text: "earlier",
        created_at: now,
        saved_at: now,
        settled_at: now,
      });
    expect(await create("open", "use staging")).toBe("pending");
    expect(
      await steers.listPending.handler(ctx as never, { chatId: "chat" }),
    ).toEqual([expect.objectContaining({ id: "open" })]);
    expect(await claim()).toEqual([{ id: "open", text: "use staging" }]);
    for (let index = 1; index < 10; index++) await create(`more-${index}`);
    await expect(create("overflow")).rejects.toThrow(
      "Wait for the Agent to read your earlier messages.",
    );
  });

  it("reports a full deletion batch so the chat is deleted only after its steers", async () => {
    const { create, ctx, rows } = fixture();
    for (let index = 0; index < 100; index++)
      rows.agent_steers.push({
        _id: `old-${index}`,
        id: `old-${index}`,
        chat_id: "chat",
        user_id: "owner",
        run_id: "run-1",
        text: "x",
        created_at: 0,
        settled_at: Date.now(),
      });
    await create("last");
    expect(await deleteAgentSteersForChat(ctx as never, "chat")).toBe(true);
    expect(await deleteAgentSteersForChat(ctx as never, "chat")).toBe(false);
    expect(rows.agent_steers).toEqual([]);
  });

  it("moves a withdrawn steer into the queue under its own ID, once", async () => {
    const { create, withdraw, rows, listQueue } = fixture();
    await create("a", "use staging");
    rows.chats[0].active_trigger_run_id = undefined;
    await withdraw("a");
    // Same ID: saving it as a user message later retires this queued row.
    expect(await listQueue()).toEqual([
      expect.objectContaining({
        id: "a",
        text: "use staging",
        fromSteer: true,
      }),
    ]);
    expect(await withdraw("a")).toEqual({ outcome: "not_found" });
    expect(rows.queued_messages).toHaveLength(1);
  });

  it("returns an unread steer even when the queue is full", async () => {
    const { create, withdraw, enqueue, rows, listQueue } = fixture();
    await create("steer", "use staging");
    for (let index = 0; index < 10; index++) await enqueue(`q${index}`);
    await expect(enqueue("overflow")).rejects.toThrow(
      "Please wait for queued messages to send before adding more.",
    );
    rows.chats[0].active_trigger_run_id = undefined;
    await withdraw("steer");
    expect((await listQueue()).map((row) => row.id)).toContain("steer");
  });

  it("takes a steered queued message out of the queue in the same write", async () => {
    const { ctx, enqueue, rows, listQueue } = fixture();
    await enqueue("queued", "check the login form");
    await enqueue("edited", "old text");
    const steer = (id: string, queuedId: string, text: string) =>
      steers.create.handler(ctx as never, {
        chatId: "chat",
        id,
        text,
        sentAt: 1_000,
        queuedId,
      });
    expect(await steer("s1", "queued", "check the login form")).toBe("pending");
    // Edited after the steer left: the newer text stays queued.
    rows.queued_messages.find((row) => row.id === "edited")!.text = "new text";
    await steer("s2", "edited", "old text");
    expect((await listQueue()).map((row) => row.text)).toEqual(["new text"]);
  });

  it("keeps each account's queue private", async () => {
    const owner = fixture();
    await owner.enqueue("a", "private");
    const intruder = fixture("intruder");
    intruder.rows.queued_messages = owner.rows.queued_messages;
    expect(
      await queue.list.handler(intruder.ctx as never, { chatId: "chat" }),
    ).toEqual([]);
    await queue.update.handler(intruder.ctx as never, {
      chatId: "chat",
      id: "a",
      text: "changed",
    });
    await queue.remove.handler(intruder.ctx as never, {
      chatId: "chat",
      id: "a",
    });
    await expect(intruder.enqueue("b")).rejects.toThrow("Chat not found");
    expect(owner.rows.queued_messages).toEqual([
      expect.objectContaining({ id: "a", text: "private" }),
    ]);
  });

  it("stores queued file parts without expiring URLs or local paths", async () => {
    const { ctx, rows } = fixture();
    await queue.enqueue.handler(ctx as never, {
      chatId: "chat",
      id: "earlier",
      text: "",
      sentAt: 1_000,
      files: [
        {
          type: "file",
          fileId: "file-1",
          name: "scan.txt",
          mediaType: "text/plain",
          size: 4,
          url: "https://expiring.example/scan.txt",
          localPath: "/Users/me/scan.txt",
        },
      ],
    });
    expect(rows.queued_messages[0].files).toEqual([
      {
        type: "file",
        fileId: "file-1",
        name: "scan.txt",
        mediaType: "text/plain",
        size: 4,
      },
    ]);
  });

  it("retires a queued message when its user message is saved, only for its owner", async () => {
    const { ctx, enqueue, listQueue } = fixture();
    await enqueue("a");
    await retireQueuedMessage(ctx as never, {
      id: "a",
      chatId: "chat",
      userId: "intruder",
    });
    expect(await listQueue()).toHaveLength(1);
    await retireQueuedMessage(ctx as never, {
      id: "a",
      chatId: "chat",
      userId: "owner",
    });
    expect(await listQueue()).toEqual([]);
  });

  describe("server dispatch of the next queued message", () => {
    // The finished run's state as the worker leaves it before onSuccess.
    const finished = (f: ReturnType<typeof fixture>, finishReason = "stop") => {
      f.rows.chats[0].active_trigger_run_id = undefined;
      f.rows.chats[0].finish_reason = finishReason;
    };
    const claimNext = (f: ReturnType<typeof fixture>, runId = "run-1") =>
      queue.claimNextForDispatch.handler(f.ctx as never, {
        serviceKey: "service-key",
        chatId: "chat",
        userId: "owner",
        completedRunId: runId,
      });

    it("claims the oldest message once, after unread steers join in send order", async () => {
      const f = fixture();
      await f.enqueue("queued-later", "later", 5_000);
      // Sent before the queued message but never read by the run.
      await steers.create.handler(f.ctx as never, {
        chatId: "chat",
        id: "unread",
        text: "use staging",
        sentAt: 1_000,
      });
      finished(f);
      f.rows.queued_messages.sort(
        (a, b) => Number(a.sent_at) - Number(b.sent_at),
      );
      // The fake index does not sort inserts; the real one orders by sent_at.
      const sortQueue = f.ctx.db.insert;
      f.ctx.db.insert = async (table, value) => {
        await sortQueue(table, value);
        f.rows.queued_messages.sort(
          (a, b) => Number(a.sent_at) - Number(b.sent_at),
        );
      };
      expect(await claimNext(f)).toEqual(
        expect.objectContaining({ id: "unread", text: "use staging" }),
      );
      // A late save of the finished run must not show the steer again.
      expect(f.rows.agent_steers[0].withdrawn_at).toEqual(expect.any(Number));
      // Already being sent: a repeat callback claims nothing.
      expect(await claimNext(f)).toBeNull();
      expect(await f.listQueue()).toEqual([
        expect.objectContaining({ id: "unread", dispatching: true }),
        expect.objectContaining({ id: "queued-later" }),
      ]);
    });

    it("leaves the queue to the user when the run did not finish normally", async () => {
      for (const setup of [
        (f: ReturnType<typeof fixture>) => finished(f, "length"),
        (f: ReturnType<typeof fixture>) => {
          finished(f);
          f.rows.chats[0].canceled_at = 1;
        },
        (f: ReturnType<typeof fixture>) => {
          finished(f);
          f.rows.chats[0].active_agent_user_wait = { toolCallId: "t" };
        },
        (f: ReturnType<typeof fixture>) => {
          finished(f);
          f.rows.chats[0].active_trigger_run_id = "run-user-started";
        },
        (f: ReturnType<typeof fixture>) => {
          finished(f);
          f.rows.agent_goals.push({
            _id: "goal",
            chatId: "chat",
            state: "running",
          });
        },
      ]) {
        const f = fixture();
        await f.enqueue("q");
        setup(f);
        expect(await claimNext(f)).toBeNull();
      }
    });

    it("never sends a message whose Desktop attachment exists only in one browser", async () => {
      const f = fixture();
      await queue.enqueue.handler(f.ctx as never, {
        chatId: "chat",
        id: "local",
        text: "see file",
        sentAt: 1,
        files: [
          {
            type: "file",
            name: "a.txt",
            mediaType: "text/plain",
            size: 1,
            storage: "local-desktop",
          },
        ],
      });
      finished(f);
      expect(await claimNext(f)).toBeNull();
    });

    it("releases a claim only for the dispatch that holds it, and expires stale claims", async () => {
      const f = fixture();
      await f.enqueue("q");
      finished(f);
      const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
      await claimNext(f);
      const release = (runId: string) =>
        queue.releaseDispatch.handler(f.ctx as never, {
          serviceKey: "service-key",
          chatId: "chat",
          userId: "owner",
          id: "q",
          completedRunId: runId,
        });
      await release("run-other");
      expect(f.rows.queued_messages[0].dispatch_claimed_at).toBe(10_000);
      // A dispatcher that died: the claim lapses and the next finish retries.
      now.mockReturnValue(10_000 + 3 * 60 * 1000);
      expect(await claimNext(f, "run-1")).toEqual(
        expect.objectContaining({ id: "q" }),
      );
      await release("run-1");
      now.mockRestore();
      expect(f.rows.queued_messages[0].dispatch_claimed_at).toBeUndefined();
    });
  });
});
