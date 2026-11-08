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
import { webcrypto } from "node:crypto";
import { signServiceArgs } from "../../lib/db/service-proof";
import * as scheduleFunctions from "../schedules";
import {
  save,
  list,
  claim,
  setEnabled,
  remove,
  finishDispatch,
  failDispatcher,
  recordOutcome,
  beginDispatch,
  recoverUncertainStarts,
  hasAny,
} from "../schedules";
import { assertUserCanAccessChatHistory } from "../lib/suspensionGuards";

type Row = { _id: string; _creationTime: number; [key: string]: any };
function store() {
  let serial = 0;
  const tables: Record<string, Row[]> = {
    local_sandbox_connections: [],
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
          lt: (a: any, b: any) => a === undefined || a < b,
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
const deployment = "https://schedules-fixture.convex.cloud";
const originalEnvironment = { ...process.env };
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const definition = {
  name: "Check",
  prompt: "Reply hello",
  model: "default" as const,
  timing: { type: "interval" as const, minutes: 15 },
};
const call = async (fn: any, ctx: any, args: any) => {
  const name = `schedules:${Object.entries(scheduleFunctions).find(([, value]) => value === fn)![0]}`;
  const type = [
    "list",
    "hasAny",
    "due",
    "getForDispatch",
    "unsettled",
    "queuedManual",
    "abandonedDispatches",
  ].includes(name.split(":")[1])
    ? "query"
    : "mutation";
  return fn.handler(
    {
      ...ctx,
      meta: {
        getFunctionMetadata: async () => ({ name, type, componentPath: "" }),
      },
    },
    await signServiceArgs({ deployment, name, type }, args),
  );
};
it("retains an ambiguous active receipt through repeated overlap trimming", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  const first = await call(claim, ctx, {
    ...auth,
    id,
    revision: 1,
    manual: true,
    dispatcherId: "blocked",
    chatId: "original",
  });
  await call(finishDispatch, ctx, {
    serviceKey: auth.serviceKey,
    id: first.id,
    dispatcherId: "blocked",
    status: "uncertain_start",
  });
  const clock = jest.spyOn(Date, "now");
  try {
    for (let n = 0; n < 205; n++) {
      const at = tables.agent_schedules[0].next_run_at;
      clock.mockReturnValue(at);
      expect(
        await call(claim, ctx, {
          ...auth,
          id,
          revision: 1,
          at,
          manual: false,
          dispatcherId: `tick-${n}`,
          chatId: `other-${n}`,
        }),
      ).toBeNull();
    }
    expect(tables.schedule_runs).toHaveLength(200);
    expect(await ctx.db.get(first.id)).toMatchObject({
      status: "uncertain_start",
      chat_id: "original",
    });
  } finally {
    clock.mockRestore();
  }
});
it("recovers ambiguous starts only after matching task execution evidence arrives", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  const first = await call(claim, ctx, {
    ...auth,
    id,
    revision: 1,
    manual: true,
    dispatcherId: "d",
    chatId: "original",
  });
  await call(finishDispatch, ctx, {
    serviceKey: auth.serviceKey,
    id: first.id,
    dispatcherId: "d",
    status: "uncertain_start",
  });
  await call(recoverUncertainStarts, ctx, auth);
  expect(tables.schedule_runs[0].status).toBe("uncertain_start");
  const clock = jest.spyOn(Date, "now");
  try {
    clock.mockReturnValue(Date.now() + 31000);
    tables.chats.push({
      _id: "chat",
      _creationTime: 1,
      id: "original",
      user_id: "owner",
      active_trigger_run_id: "confirmed-child",
    });
    await call(recoverUncertainStarts, ctx, auth);
    expect(tables.schedule_runs[0]).toMatchObject({
      status: "started",
      trigger_run_id: "confirmed-child",
    });
    await expect(
      call(claim, ctx, {
        ...auth,
        id,
        revision: 1,
        manual: true,
        dispatcherId: "replacement",
        chatId: "new",
      }),
    ).rejects.toThrow();
    tables.schedule_runs[0].status = "uncertain_start";
    tables.schedule_runs[0].last_checked_at = undefined;
    tables.chats[0].active_trigger_run_id = undefined;
    tables.chats[0].last_run_finished_at = Date.now();
    await call(recoverUncertainStarts, ctx, auth);
    expect(tables.schedule_runs[0].status).toBe("unconfirmed");
  } finally {
    clock.mockRestore();
  }
});
beforeEach(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = auth.serviceKey;
  process.env.CONVEX_CLOUD_URL = deployment;
  delete process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL;
});
afterAll(() => {
  process.env = originalEnvironment;
});
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
  it("reports only the current owner's existing schedules for management navigation", async () => {
    const { ctx } = await setup();
    expect(await call(hasAny, ctx, auth)).toBe(true);
    expect(await call(hasAny, ctx, { ...auth, userId: "other" })).toBe(false);
  });
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
    tables.schedule_runs.push(
      ...Array.from({ length: 200 }, (_, i) => ({
        _id: `removed-${i}`,
        _creationTime: i,
        schedule_id: id,
      })),
      { _id: "unrelated", _creationTime: 201, schedule_id: "another-schedule" },
    );
    tables.chats.push({
      _id: "chat",
      _creationTime: 1,
      id: "c",
      user_id: "owner",
    });
    await call(remove, ctx, { ...auth, id });
    expect(tables.agent_schedules).toHaveLength(0);
    expect(tables.chats).toHaveLength(1);
    expect(tables.schedule_runs).toEqual([
      expect.objectContaining({ _id: "unrelated" }),
    ]);
  });
});

it("preserves the next interval when only instructions or name are edited", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  // Persisted Convex objects do not retain the input's property insertion order.
  tables.agent_schedules[0].definition.timing = {
    minutes: 15,
    type: "interval",
  };
  const due = tables.agent_schedules[0].next_run_at;
  jest.spyOn(Date, "now").mockReturnValue(due - 60000);
  try {
    await call(save, ctx, {
      ...auth,
      id,
      definition: {
        ...definition,
        name: "Renamed",
        prompt: "Updated instructions",
      },
    });
    expect(tables.agent_schedules[0].next_run_at).toBe(due);
  } finally {
    jest.restoreAllMocks();
  }
});
it("atomically reserves Run now and lets the worker reuse that queued receipt", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  const args = {
    ...auth,
    id,
    revision: 1,
    manual: true,
    dispatcherId: "manual-request",
    chatId: "stable",
  };
  const queued = await call(claim, ctx, { ...args, queueOnly: true });
  expect(tables.schedule_runs[0].status).toBe("queued");
  await expect(
    call(claim, ctx, {
      ...args,
      dispatcherId: "second-request",
      queueOnly: true,
    }),
  ).rejects.toThrow();
  expect(await call(claim, ctx, { ...args, chatId: "different" })).toEqual(
    queued,
  );
  expect(tables.schedule_runs[0].status).toBe("starting");
});
it("keeps a live task fenced when the provider outcome is unavailable", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  const run = await call(claim, ctx, {
    ...auth,
    id,
    revision: 1,
    manual: true,
    dispatcherId: "request",
    chatId: "chat",
  });
  await call(finishDispatch, ctx, {
    serviceKey: "service",
    id: run.id,
    dispatcherId: "request",
    status: "started",
    triggerRunId: "child",
  });
  tables.chats.push({
    _id: "c",
    _creationTime: 1,
    id: "chat",
    user_id: "owner",
    active_trigger_run_id: "child",
  });
  await call(recordOutcome, ctx, {
    serviceKey: "service",
    id: run.id,
    triggerRunId: "child",
    status: "unconfirmed",
  });
  expect(tables.schedule_runs[0].status).toBe("started");
  tables.chats[0].active_trigger_run_id = undefined;
  tables.chats[0].last_run_finished_at = Date.now();
  await call(recordOutcome, ctx, {
    serviceKey: "service",
    id: run.id,
    triggerRunId: "child",
    status: "unconfirmed",
  });
  expect(tables.schedule_runs[0].status).toBe("unconfirmed");
});
it("rearms a consumed one-time schedule when its date is edited", async () => {
  const { ctx, tables } = store();
  const firstAt = Date.now() + 60000;
  const id = await call(save, ctx, {
    ...auth,
    definition: { ...definition, timing: { type: "once", at: firstAt } },
  });
  jest.spyOn(Date, "now").mockReturnValue(firstAt);
  try {
    await call(claim, ctx, {
      ...auth,
      id,
      revision: 1,
      manual: false,
      at: firstAt,
      dispatcherId: "clock",
      chatId: "chat",
    });
    expect(tables.agent_schedules[0].consumed_at).toBe(firstAt);
    const later = firstAt + 60000;
    await call(save, ctx, {
      ...auth,
      id,
      definition: { ...definition, timing: { type: "once", at: later } },
    });
    expect(tables.agent_schedules[0]).toMatchObject({
      enabled: true,
      next_run_at: later,
      consumed_at: undefined,
    });
  } finally {
    jest.restoreAllMocks();
  }
});

it("keeps an ambiguous start fenced instead of replaying it", async () => {
  const { ctx, tables } = store();
  const id = await call(save, ctx, { ...auth, definition });
  const args = {
    ...auth,
    id,
    revision: 1,
    manual: true,
    dispatcherId: "request",
    chatId: "chat",
  };
  const receipt = await call(claim, ctx, args);
  expect(
    await call(beginDispatch, ctx, {
      serviceKey: "service",
      id: receipt.id,
      dispatcherId: "request",
    }),
  ).toBe(true);
  await call(failDispatcher, ctx, {
    serviceKey: "service",
    scheduleId: id,
    revision: 1,
    manual: true,
    dispatcherId: "request",
  });
  expect(tables.schedule_runs[0].status).toBe("uncertain_start");
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  try {
    await expect(
      call(claim, ctx, { ...args, dispatcherId: "replacement" }),
    ).rejects.toThrow("already has a run");
  } finally {
    jest.restoreAllMocks();
  }
});

it.each([false, true])(
  "keeps a past one-time schedule disabled when renamed (consumed=%s)",
  async (consumed) => {
    const { ctx, tables } = store();
    const at = Date.now() + 60000;
    const original = { ...definition, timing: { type: "once" as const, at } };
    const id = await call(save, ctx, { ...auth, definition: original });
    tables.agent_schedules[0].enabled = false;
    tables.agent_schedules[0].next_run_at = undefined;
    if (consumed) tables.agent_schedules[0].consumed_at = at;
    jest.spyOn(Date, "now").mockReturnValue(at + 60000);
    try {
      await call(save, ctx, {
        ...auth,
        id,
        definition: { ...original, name: "Renamed schedule" },
      });
      expect(tables.agent_schedules[0]).toMatchObject({
        definition: { ...original, name: "Renamed schedule" },
        enabled: false,
        next_run_at: undefined,
        consumed_at: consumed ? at : undefined,
      });
    } finally {
      jest.restoreAllMocks();
    }
  },
);

const localExecution = {
  type: "local",
  preference: "environment:12345678-1234-4123-8123-123456789abc",
  name: "Forged label",
  workingDirectory: "/tmp/lab",
};
it("binds local schedules only to the owner's computer, and retains offline edits", async () => {
  const { ctx, tables } = store();
  await ctx.db.insert("local_sandbox_connections", {
    user_id: "other",
    environment_id: localExecution.preference.split(":")[1],
    client_version: "1.0",
    mode: "dangerous",
    connection_name: "Other computer",
  });
  await expect(
    call(save, ctx, {
      ...auth,
      definition: { ...definition, execution: localExecution },
    }),
  ).rejects.toThrow("computer is unavailable");
  await ctx.db.insert("local_sandbox_connections", {
    user_id: "owner",
    environment_id: localExecution.preference.split(":")[1],
    client_version: "1.0",
    mode: "dangerous",
    connection_name: "My lab",
  });
  const id = await call(save, ctx, {
    ...auth,
    definition: { ...definition, execution: localExecution },
  });
  expect(tables.agent_schedules[0].definition.execution.name).toBe("My lab");
  tables.local_sandbox_connections = [];
  await call(save, ctx, {
    ...auth,
    id,
    definition: {
      ...definition,
      name: "Renamed offline",
      execution: localExecution,
    },
  });
  expect(tables.agent_schedules[0].definition.execution.name).toBe("My lab");
  await expect(
    call(save, ctx, {
      ...auth,
      id,
      definition: {
        ...definition,
        execution: {
          ...localExecution,
          preference: localExecution.preference.replace(
            "environment:",
            "desktop-environment:",
          ),
        },
      },
    }),
  ).rejects.toThrow("computer is unavailable");
});
