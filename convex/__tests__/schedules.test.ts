jest.mock("../_generated/server", () => ({
  query: (c: unknown) => c,
  mutation: (c: unknown) => c,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "service") throw Error("Unauthorized");
  },
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn().mockResolvedValue(undefined),
}));
import {
  save,
  list,
  claim,
  setEnabled,
  remove,
  finishDispatch,
  failDispatcher,
  recordOutcome,
} from "../schedules";
import { assertUserCanAccessChatHistory } from "../lib/suspensionGuards";

type Row = { _id: string; _creationTime: number; [key: string]: any };
function store() {
  let serial = 0;
  const tables: Record<string, Row[]> = {
    agent_schedules: [],
    schedule_runs: [],
    chats: [],
    user_deletion_fences: [],
  };
  const db: any = {
    get: async (id: string) =>
      Object.values(tables)
        .flat()
        .find((r) => r._id === id) ?? null,
    insert: async (table: string, value: any) => {
      const id = `${table}-${++serial}`;
      tables[table].push({ _id: id, _creationTime: serial, ...value });
      return id;
    },
    patch: async (id: string, patch: any) =>
      Object.assign(await db.get(id), patch),
    delete: async (id: string) => {
      for (const key in tables)
        tables[key] = tables[key].filter((r) => r._id !== id);
    },
    query: (table: string) => ({
      withIndex: (_name: string, build: (q: any) => any) => {
        const filters: Array<(r: Row) => boolean> = [];
        const q: any = {};
        for (const [op, test] of Object.entries({
          eq: (a: any, b: any) => a === b,
          gt: (a: any, b: any) => a > b,
          lte: (a: any, b: any) => a <= b,
        }))
          q[op] = (field: string, value: any) => {
            filters.push((r) => test(r[field], value));
            return q;
          };
        build(q);
        let rows = tables[table].filter((r) => filters.every((f) => f(r)));
        const result: any = {
          first: async () => rows[0] ?? null,
          unique: async () => rows[0] ?? null,
          take: async (n: number) => rows.slice(0, n),
          order: (direction: string) => {
            rows = rows.sort((a, b) =>
              direction === "desc"
                ? b._creationTime - a._creationTime
                : a._creationTime - b._creationTime,
            );
            return result;
          },
        };
        return result;
      },
    }),
  };
  return { ctx: { db } as any, tables };
}
const auth = { serviceKey: "service", userId: "owner" };
const definition = {
  name: "Check",
  prompt: "Reply hello",
  model: "default" as const,
  timing: { type: "interval" as const, minutes: 15 },
};
const call = (fn: any, ctx: any, args: any) => fn.handler(ctx, args);
describe("durable schedules", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-07T20:00:00Z"));
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());
  async function setup() {
    const s = store();
    const id = await call(save, s.ctx, { ...auth, definition });
    return { ...s, id };
  }
  it("enforces service authentication and schedule ownership", async () => {
    const { ctx, id } = await setup();
    await expect(
      call(save, ctx, { ...auth, serviceKey: "wrong", definition }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      call(setEnabled, ctx, {
        ...auth,
        userId: "intruder",
        id,
        enabled: false,
      }),
    ).rejects.toThrow("Schedule not found");
    await expect(
      call(remove, ctx, { ...auth, userId: "intruder", id }),
    ).rejects.toThrow("Schedule not found");
  });
  it("does not recreate schedules after account deletion begins", async () => {
    const { ctx, tables } = await setup();
    tables.user_deletion_fences.push({
      _id: "fence",
      _creationTime: 1,
      user_id: "owner",
    });
    await expect(call(save, ctx, { ...auth, definition })).rejects.toThrow(
      "being deleted",
    );
  });
  it("deduplicates ticks and preserves the same chat on a retry", async () => {
    const { ctx, id, tables } = await setup();
    const at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at);
    const args = {
      ...auth,
      id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "dispatch-1",
      chatId: "chat-1",
    };
    const first = await call(claim, ctx, args);
    expect(await call(claim, ctx, { ...args, chatId: "different" })).toEqual(
      first,
    );
    expect(
      await call(claim, ctx, { ...args, dispatcherId: "dispatch-2" }),
    ).toBeNull();
    expect(tables.schedule_runs).toHaveLength(1);
    expect(tables.agent_schedules[0].next_run_at).toBe(at + 900000);
  });
  it("fences stale queued ticks after pause, resume, edit, or delete", async () => {
    const { ctx, id, tables } = await setup();
    const at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at);
    const args = {
      ...auth,
      id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "d",
      chatId: "c",
    };
    await call(setEnabled, ctx, { ...auth, id, enabled: false });
    expect(await call(claim, ctx, args)).toBeNull();
    await call(setEnabled, ctx, { ...auth, id, enabled: true });
    expect(await call(claim, ctx, args)).toBeNull();
    await call(save, ctx, { ...auth, id, definition });
    expect(await call(claim, ctx, args)).toBeNull();
    await call(remove, ctx, { ...auth, id });
    await expect(call(claim, ctx, args)).rejects.toThrow("not found");
  });
  it("skips overlap and advances recurring work without accumulating missed runs", async () => {
    const { ctx, id, tables } = await setup();
    let at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at);
    await call(claim, ctx, {
      ...auth,
      id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "d1",
      chatId: "c1",
    });
    at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at + 3600000);
    expect(
      await call(claim, ctx, {
        ...auth,
        id,
        revision: 1,
        at,
        manual: false,
        dispatcherId: "d2",
        chatId: "c2",
      }),
    ).toBeNull();
    expect(tables.schedule_runs[1].status).toBe("skipped");
    expect(tables.agent_schedules[0].next_run_at).toBe(Date.now() + 900000);
  });
  it("run now does not move the regular cadence and prevents rapid duplicate runs", async () => {
    const { ctx, id, tables } = await setup();
    const next = tables.agent_schedules[0].next_run_at;
    await call(claim, ctx, {
      ...auth,
      id,
      revision: 1,
      manual: true,
      dispatcherId: "m1",
      chatId: "c1",
    });
    expect(tables.agent_schedules[0].next_run_at).toBe(next);
    await expect(
      call(claim, ctx, {
        ...auth,
        id,
        revision: 1,
        manual: true,
        dispatcherId: "m2",
        chatId: "c2",
      }),
    ).rejects.toThrow("Wait a minute");
  });
  it("allows a later run after actual task completion", async () => {
    const { ctx, id, tables } = await setup();
    const at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at);
    const run = await call(claim, ctx, {
      ...auth,
      id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "d1",
      chatId: "c1",
    });
    await call(finishDispatch, ctx, {
      serviceKey: "service",
      id: run.id,
      dispatcherId: "d1",
      status: "started",
      triggerRunId: "real-run",
    });
    tables.chats.push({
      _id: "chat",
      _creationTime: 1,
      id: "c1",
      user_id: "owner",
      last_run_finished_at: at + 100,
      finish_reason: "stop",
    });
    expect((await call(list, ctx, auth))[0].runs[0].status).toBe("finishing");
    await call(recordOutcome, ctx, {
      serviceKey: "service",
      id: run.id,
      triggerRunId: "real-run",
      status: "finished",
    });
    expect((await call(list, ctx, auth))[0].runs[0].status).toBe("finished");
    const next = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(next);
    expect(
      await call(claim, ctx, {
        ...auth,
        id,
        revision: 1,
        at: next,
        manual: false,
        dispatcherId: "d2",
        chatId: "c2",
      }),
    ).not.toBeNull();
  });
  it("consumes one-time schedules exactly once", async () => {
    const { ctx, id, tables } = await setup();
    const at = Date.now() + 60000;
    await call(save, ctx, {
      ...auth,
      id,
      definition: { ...definition, timing: { type: "once", at } },
    });
    jest.setSystemTime(at);
    await call(claim, ctx, {
      ...auth,
      id,
      revision: 2,
      at,
      manual: false,
      dispatcherId: "d1",
      chatId: "c1",
    });
    expect(tables.agent_schedules[0]).toMatchObject({
      enabled: false,
      next_run_at: undefined,
    });
  });
  it("recovers a confirmed child instead of replaying after a failed receipt write", async () => {
    const { ctx, id, tables } = await setup();
    const at = tables.agent_schedules[0].next_run_at;
    jest.setSystemTime(at);
    await call(claim, ctx, {
      ...auth,
      id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "d",
      chatId: "c",
    });
    tables.chats.push({
      _id: "chat",
      _creationTime: 1,
      id: "c",
      active_trigger_run_id: "actual",
    });
    await call(failDispatcher, ctx, {
      serviceKey: "service",
      scheduleId: id,
      revision: 1,
      at,
      manual: false,
      dispatcherId: "d",
    });
    expect(tables.schedule_runs[0]).toMatchObject({
      status: "started",
      trigger_run_id: "actual",
    });
  });
  it("retains normal task results when removing a schedule", async () => {
    const { ctx, id, tables } = await setup();
    tables.chats.push({
      _id: "chat",
      _creationTime: 1,
      id: "c",
      user_id: "owner",
    });
    await call(remove, ctx, { ...auth, id });
    expect(tables.agent_schedules).toHaveLength(0);
    expect(tables.chats).toHaveLength(1);
  });
});
