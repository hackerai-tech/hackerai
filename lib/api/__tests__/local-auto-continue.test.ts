/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { getFunctionName } from "convex/server";
import { NextRequest, NextResponse } from "next/server";

/**
 * HAC-275 end to end on the server: the worker records a lost-connection
 * stop, the Desktop reports its return, and the route decides through the
 * real Convex decision record. Only Convex storage, auth, PostHog and the
 * Agent start/cancel handlers are replaced. The fake database runs one
 * mutation at a time, as Convex transactions do.
 */

jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("@/convex/lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "service-key") throw new Error("Unauthorized");
  },
}));

type Row = Record<string, unknown> & { _id: string };
const tables: Record<string, Row[]> = {};
let nextId = 0;

function index(table: string) {
  return {
    withIndex: (_name: string, build?: (q: unknown) => unknown) => {
      const equals: Record<string, unknown> = {};
      const ranges: Array<(row: Row) => boolean> = [];
      const q = {
        eq(field: string, value: unknown) {
          equals[field] = value;
          return q;
        },
        gt(field: string, value: number) {
          ranges.push(
            (row) =>
              typeof row[field] === "number" && (row[field] as number) > value,
          );
          return q;
        },
        lte(field: string, value: number) {
          ranges.push(
            (row) =>
              typeof row[field] === "number" && (row[field] as number) <= value,
          );
          return q;
        },
      };
      build?.(q);
      let rows = () =>
        (tables[table] ?? []).filter(
          (row) =>
            Object.entries(equals).every(
              ([key, value]) => row[key] === value,
            ) && ranges.every((range) => range(row)),
        );
      const result = {
        order(direction: "asc" | "desc") {
          const unordered = rows;
          rows = () =>
            unordered().sort(
              (a, b) =>
                (Number(a.stopped_at ?? a._creationTime) -
                  Number(b.stopped_at ?? b._creationTime)) *
                (direction === "desc" ? -1 : 1),
            );
          return result;
        },
        first: async () => rows()[0] ?? null,
        unique: async () => {
          const found = rows();
          if (found.length > 1) throw new Error("not unique");
          return found[0] ?? null;
        },
        take: async (count: number) => rows().slice(0, count),
        collect: async () => rows(),
      };
      return result;
    },
  };
}

const db = {
  query: index,
  insert: async (table: string, value: Record<string, unknown>) => {
    const _id = `${table}-${++nextId}`;
    (tables[table] ??= []).push({ _id, ...value });
    return _id;
  },
  get: async (id: string) =>
    Object.values(tables)
      .flat()
      .find((row) => row._id === id) ?? null,
  patch: async (id: string, value: Record<string, unknown>) => {
    const row = Object.values(tables)
      .flat()
      .find((entry) => entry._id === id);
    if (!row) throw new Error("missing row");
    Object.assign(row, value);
  },
};

// Convex runs mutations as serializable transactions; model that with a queue.
let transaction: Promise<unknown> = Promise.resolve();
/** Calls that fail before committing, by function name, counted down. */
const failures: Record<string, number> = {};
async function call(reference: unknown, args: Record<string, unknown>) {
  const [moduleName, name] = getFunctionName(reference as never).split(":");
  if (moduleName !== "agentLocalAutoContinues")
    throw new Error(`unexpected Convex call ${moduleName}`);
  if (failures[name]) {
    failures[name]--;
    throw new Error("Convex unavailable");
  }
  const handlers = require("@/convex/agentLocalAutoContinues") as Record<
    string,
    { handler: (ctx: unknown, args: unknown) => Promise<unknown> }
  >;
  const run = transaction.then(() =>
    handlers[name].handler({ db, auth: {} }, args),
  );
  transaction = run.catch(() => undefined);
  return run;
}

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: call, query: call }),
  setConvexUrl: () => undefined,
}));

const mockUserId = jest.fn(() => "owner");
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: async () => ({ userId: mockUserId() }),
}));

const mockCapture = jest.fn();
const mockFlag = jest.fn<() => Promise<unknown>>();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    capture: mockCapture,
    getFeatureFlagResult: mockFlag,
    shutdown: async () => undefined,
  }),
}));

const { createLocalAutoContinuePost, cancelLocalAutoContinuesForChat } =
  require("@/lib/api/local-auto-continue-route") as typeof import("@/lib/api/local-auto-continue-route");
const { recordLocalAutoContinueStop } =
  require("@/trigger/agent-local-auto-continue") as typeof import("@/trigger/agent-local-auto-continue");
const { LocalConnectionLostError } =
  require("@/lib/chat/local-connection-stop") as typeof import("@/lib/chat/local-connection-stop");
const { localAutoContinueMessageId } =
  require("@/lib/chat/local-auto-continue") as typeof import("@/lib/chat/local-auto-continue");

const STOPPED_CONNECTION = "0b8a3f2e-6a3c-4c1e-9d3e-0f1a2b3c4d5e";
const LAUNCH = "a".repeat(32);
const NOW = 1_800_000_000_000;
let now = NOW;

function connection(
  connectionId: string,
  overrides: Record<string, unknown> = {},
) {
  (tables.local_sandbox_connections ??= []).push({
    _id: `connection-${connectionId}`,
    connection_id: connectionId,
    user_id: "owner",
    registration_origin: "desktop",
    environment_id: "computer-1",
    native_launch_id: LAUNCH,
    native_page_generation: 0,
    status: "connected",
    ...overrides,
  });
}

function stoppedChat(overrides: Record<string, unknown> = {}) {
  tables.chats = [
    {
      _id: "chat-row",
      id: "chat",
      user_id: "owner",
      finish_reason: "local-connection-lost",
      last_run_finished_at: now,
      ...overrides,
    },
  ];
}

const payload = {
  chatId: "chat",
  userId: "owner",
  subscription: "pro",
  messages: [],
  baseTodos: [],
  sandboxPreference: "desktop",
  agentPermissionMode: "full_access",
  selectedModel: "auto",
  userLocation: {},
} as never;

function recordStop(
  stoppedRunId = "run_stopped",
  reason: string = "selected_host_recovery_expired",
  usageLimited = false,
) {
  return recordLocalAutoContinueStop({
    payload,
    stoppedRunId,
    stopCause: new LocalConnectionLostError(reason as never, {
      connectionId: STOPPED_CONNECTION,
    }),
    usageLimited,
  });
}

const startAgent = jest.fn<(req: NextRequest) => Promise<Response>>();
const cancelAgent = jest.fn<(req: NextRequest) => Promise<Response>>();
const POST = createLocalAutoContinuePost({
  startAgent,
  cancelAgent,
  sleep: async () => undefined,
});

const report = (connectionId = "returned-connection") =>
  POST(
    new NextRequest("http://localhost/api/agent/local-auto-continue", {
      method: "POST",
      headers: { cookie: "session=fixture", "x-vercel-ip-country": "US" },
      body: JSON.stringify({ action: "return", connectionId }),
    }),
  );

/** What the chat page reads to show "Your computer is back — continuing". */
const chatNotice = () =>
  (
    require("@/convex/agentLocalAutoContinues") as Record<
      string,
      { handler: (ctx: unknown, args: unknown) => Promise<unknown> }
    >
  ).getForChat.handler(
    { db, auth: { getUserIdentity: async () => ({ subject: "owner" }) } },
    { chatId: "chat" },
  );

const startBodies = async () =>
  Promise.all(startAgent.mock.calls.map(([req]) => req.clone().json()));

const events = (name: string) =>
  mockCapture.mock.calls
    .map(
      ([event]) =>
        event as { event: string; properties: Record<string, unknown> },
    )
    .filter((event) => event.event === name)
    .map((event) => event.properties);

const variant = (value: "control" | "test") =>
  mockFlag.mockResolvedValue({ enabled: true, variant: value });

/** A message saved in the stopped chat after its stop. */
function messageSince(role: "user" | "assistant", at = now + 1) {
  (tables.messages ??= []).push({
    _id: `message-${++nextId}`,
    _creationTime: at,
    id: `message-${nextId}`,
    chat_id: "chat",
    user_id: "owner",
    role,
  });
}

const cancelReport = (reason: "environment_switched" | "user_stop") =>
  POST(
    new NextRequest("http://localhost/api/agent/local-auto-continue", {
      method: "POST",
      body: JSON.stringify({ action: "cancel", chatId: "chat", reason }),
    }),
  );

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  for (const key of Object.keys(failures)) delete failures[key];
  now = NOW;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
  mockCapture.mockReset();
  mockFlag.mockReset();
  variant("test");
  startAgent
    .mockReset()
    .mockImplementation(async () =>
      NextResponse.json({ runId: "run_continued" }),
    );
  cancelAgent.mockReset().mockResolvedValue(NextResponse.json({}));
  // The stopped connection, and the same Desktop session registering again.
  connection(STOPPED_CONNECTION, { status: "disconnected" });
  connection("returned-connection");
  stoppedChat();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("automatic continuation after a Desktop comes back", () => {
  it("continues an unreconciled-command stop once its session returns", async () => {
    await recordStop("run_stopped", "desktop_command_unreconciled");
    await report();

    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({ outcome: "started" }),
    ]);
  });

  it("starts one continuation however many reports of the return arrive", async () => {
    await recordStop();
    const responses = await Promise.all([report(), report(), report()]);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(startAgent).toHaveBeenCalledTimes(1);
    const [body] = await startBodies();
    // The manual Resume request shape, with the stopped run's settings and
    // a message ID that makes any retry dedupe to the same Trigger run.
    expect(body).toMatchObject({
      chatId: "chat",
      isAutoContinue: true,
      localAutoContinue: { stoppedRunId: "run_stopped" },
      // The computer that came back, never any connected Desktop.
      sandboxPreference: "desktop-environment:computer-1",
      agentPermissionMode: "full_access",
      selectedModel: "auto",
      messages: [{ id: localAutoContinueMessageId("run_stopped") }],
    });
    expect(startAgent.mock.calls[0][0].headers.get("cookie")).toBe(
      "session=fixture",
    );
    expect(events("agent_local_auto_continue_exposed")).toEqual([
      expect.objectContaining({
        stopped_run_id: "run_stopped",
        experiment_variant: "test",
        "$feature/agent-local-auto-continue-v1": "test",
      }),
    ]);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "started",
        stopped_run_id: "run_stopped",
        continued_run_id: "run_continued",
      }),
    ]);

    expect(await chatNotice()).toEqual({
      state: "started",
      stoppedRunId: "run_stopped",
      continuedRunId: "run_continued",
    });

    // A later reconnect of the same session finds nothing left to continue.
    await report();
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps the manual prompt in the control arm and records the exposure", async () => {
    variant("control");
    await recordStop();
    await report();
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_exposed")).toEqual([
      expect.objectContaining({ experiment_variant: "control" }),
    ]);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({ outcome: "manual", reason: "control" }),
    ]);
    // The chat shows today's manual Resume prompt, nothing new.
    expect(await chatNotice()).toBeNull();
  });

  it("behaves as control without an exposure when the flag is unavailable", async () => {
    mockFlag.mockRejectedValue(new Error("PostHog unavailable"));
    await recordStop();
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_exposed")).toEqual([]);
  });

  it("does not continue for another computer or a relaunch of this one", async () => {
    connection("other-computer", {
      environment_id: "computer-2",
      native_launch_id: "b".repeat(32),
    });
    connection("relaunched", { native_launch_id: "c".repeat(32) });
    connection("reloaded-page", { native_page_generation: 1 });
    await recordStop();

    await report("other-computer");
    expect(events("agent_local_auto_continue_outcome")).toEqual([]);
    await report("relaunched");
    await report("reloaded-page");
    // The original session can never return after its launch was replaced.
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_exposed")).toEqual([]);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "ineligible",
        reason: "session_replaced",
      }),
    ]);
  });

  it.each([
    ["selected_host_ended", false, "intentional_stop"],
    ["desktop_session_replaced", false, "session_replaced"],
    ["desktop_session_unverified", false, "session_unverified"],
    ["observer_disconnected", false, "not_host_departure"],
    ["selected_host_recovery_expired", true, "usage_limit"],
  ] as const)(
    "never continues a %s stop (usage limited: %s)",
    async (stopReason, usageLimited, reason) => {
      await recordStop("run_stopped", stopReason, usageLimited);
      await report();

      expect(startAgent).not.toHaveBeenCalled();
      expect(events("agent_local_auto_continue_exposed")).toEqual([]);
      expect(events("agent_local_auto_continue_outcome")).toEqual([
        expect.objectContaining({ outcome: "ineligible", reason }),
      ]);
    },
  );

  it("never continues a stop whose Desktop never proved its native session", async () => {
    tables.local_sandbox_connections[0].native_launch_id = undefined;
    await recordStop();
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "ineligible",
        reason: "session_unproven",
      }),
    ]);
  });

  it("leaves a stop older than 30 minutes for the user, without exposure", async () => {
    await recordStop();
    now += 30 * 60_000 + 1;
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_exposed")).toEqual([]);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "ineligible",
        reason: "stop_too_old",
      }),
    ]);
  });

  it.each(["user_message", "manual_resume", "user_stop"] as const)(
    "does not continue after the user acted first (%s)",
    async (reason) => {
      await recordStop();
      await cancelLocalAutoContinuesForChat({
        userId: "owner",
        chatId: "chat",
        reason,
      });
      await report();

      expect(startAgent).not.toHaveBeenCalled();
      expect(events("agent_local_auto_continue_outcome")).toEqual([
        expect.objectContaining({ outcome: "cancelled", reason }),
      ]);
    },
  );

  it("does not continue after the user picked another environment", async () => {
    await recordStop();
    await POST(
      new NextRequest("http://localhost/api/agent/local-auto-continue", {
        method: "POST",
        body: JSON.stringify({
          action: "cancel",
          chatId: "chat",
          reason: "environment_switched",
        }),
      }),
    );
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        reason: "environment_switched",
      }),
    ]);
  });

  it("does not continue when another run used the chat since the stop", async () => {
    await recordStop();
    stoppedChat({ finish_reason: "stop", last_run_finished_at: now + 1 });
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_exposed")).toEqual([]);
  });

  it("waits while the stopped run still owns its chat, then continues", async () => {
    stoppedChat({ active_trigger_run_id: "run_stopped" });
    await recordStop();
    expect(await (await report()).json()).toEqual({ pending: true });
    expect(startAgent).not.toHaveBeenCalled();

    stoppedChat();
    await report();
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it("allows three automatic continuations per chat in five minutes", async () => {
    for (const run of ["run_1", "run_2", "run_3", "run_4"]) {
      now += 1_000;
      stoppedChat();
      await recordStop(run);
      await report();
    }
    expect(startAgent).toHaveBeenCalledTimes(3);
    expect(events("agent_local_auto_continue_outcome").at(-1)).toMatchObject({
      outcome: "suppressed",
      reason: "cap",
      stopped_run_id: "run_4",
    });
    // Suppressed stops are still exposed: the user reached the eligible moment.
    expect(events("agent_local_auto_continue_exposed")).toHaveLength(4);

    now += 5 * 60_000;
    stoppedChat();
    await recordStop("run_5");
    await report();
    expect(startAgent).toHaveBeenCalledTimes(4);
  });

  it("retries a transient start failure with the same message, never a refusal", async () => {
    startAgent
      .mockResolvedValueOnce(new NextResponse("busy", { status: 503 }))
      .mockResolvedValueOnce(NextResponse.json({ runId: "run_continued" }));
    await recordStop();
    await report();

    const [first, retry] = await startBodies();
    expect(retry.messages[0].id).toBe(first.messages[0].id);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({ outcome: "started" }),
    ]);

    startAgent
      .mockReset()
      .mockResolvedValue(new NextResponse("limit", { status: 429 }));
    now += 1_000;
    stoppedChat();
    await recordStop("run_limited");
    await report();
    await report();
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(events("agent_local_auto_continue_outcome").at(-1)).toMatchObject({
      outcome: "start_failed",
      reason: "admission_refused",
    });
  });

  it("cancels the run it started when the user stopped while it was starting", async () => {
    startAgent.mockImplementation(async () => {
      await cancelLocalAutoContinuesForChat({
        userId: "owner",
        chatId: "chat",
        reason: "user_stop",
      });
      return NextResponse.json({ runId: "run_continued" });
    });
    await recordStop();
    await report();

    expect(cancelAgent).toHaveBeenCalledTimes(1);
    expect(await cancelAgent.mock.calls[0][0].json()).toEqual({
      chatId: "chat",
      expectedTriggerRunId: "run_continued",
    });
    expect(
      events("agent_local_auto_continue_outcome").map((event) => event.outcome),
    ).toEqual(["cancelled"]);
  });

  it("does not continue on a reload of the same launch", async () => {
    connection("reloaded-page", { native_page_generation: 1 });
    await recordStop();
    await report("reloaded-page");
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "ineligible",
        reason: "session_replaced",
      }),
    ]);
  });

  it.each([
    ["names another computer", "desktop-environment:computer-9", {}],
    ["ran on a Desktop without an environment", "desktop", { env: true }],
  ] as const)(
    "never continues a stop that %s, so it cannot be bound",
    async (_case, sandboxPreference, { env }: { env?: boolean }) => {
      if (env)
        for (const row of tables.local_sandbox_connections)
          row.environment_id = undefined;
      await recordLocalAutoContinueStop({
        payload: { ...(payload as object), sandboxPreference } as never,
        stoppedRunId: "run_stopped",
        stopCause: new LocalConnectionLostError(
          "selected_host_recovery_expired",
          { connectionId: STOPPED_CONNECTION },
        ),
        usageLimited: false,
      });
      await report();

      expect(startAgent).not.toHaveBeenCalled();
      expect(events("agent_local_auto_continue_outcome")).toEqual([
        expect.objectContaining({
          outcome: "ineligible",
          reason: "session_unproven",
        }),
      ]);
    },
  );

  it("does not continue after the user saved a message, even if cancelling failed", async () => {
    await recordStop();
    // The start route saved the user's message, but its cancellation write
    // and its dispatch both failed.
    failures.cancelForChat = 1;
    expect(
      await cancelLocalAutoContinuesForChat({
        userId: "owner",
        chatId: "chat",
        reason: "user_message",
      }),
    ).toBe(false);
    messageSince("user");
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "user_message" }),
    ]);
  });

  it.each(["environment_switched", "user_stop"] as const)(
    "reports an unstored %s as retryable, then honors the retry",
    async (reason) => {
      await recordStop();
      failures.cancelForChat = 1;
      const failed = await cancelReport(reason);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ ok: false, retryable: true });

      expect((await cancelReport(reason)).status).toBe(200);
      await report();
      expect(startAgent).not.toHaveBeenCalled();
    },
  );

  it("never lets a late stop report replace a later run's waiting stop", async () => {
    // Run B stopped and recorded first; run A's report arrives afterwards.
    await recordStop("run_later");
    await recordStop("run_earlier");

    const rows = Object.fromEntries(
      tables.agent_local_auto_continues.map((row) => [row.stopped_run_id, row]),
    );
    expect(rows.run_later.state).toBe("awaiting_return");
    expect(rows.run_earlier).toMatchObject({
      state: "cancelled",
      reason: "superseded",
    });
    expect(rows.run_earlier.chat_finished_at).toBeUndefined();

    await report();
    expect((await startBodies()).map((body) => body.localAutoContinue)).toEqual(
      [{ stoppedRunId: "run_later" }],
    );
  });

  it("finds this computer's stop behind many waiting stops elsewhere", async () => {
    for (let i = 0; i < 60; i++)
      tables.agent_local_auto_continues = [
        ...(tables.agent_local_auto_continues ?? []),
        {
          _id: `elsewhere-${i}`,
          stopped_run_id: `run_elsewhere_${i}`,
          chat_id: `chat-${i}`,
          user_id: "owner",
          state: "awaiting_return",
          stopped_at: now - 60_000,
          environment_id: "computer-2",
          native_launch_id: "b".repeat(32),
          native_page_generation: 0,
        },
      ];
    await recordStop();
    await report();

    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it("settles a started run after a transient settlement failure, without starting again", async () => {
    failures.settleStart = 1;
    await recordStop();
    await report();

    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(await chatNotice()).toMatchObject({
      state: "started",
      continuedRunId: "run_continued",
    });
  });

  it("stops the started run when its settlement cannot be recorded", async () => {
    failures.settleStart = 10;
    await recordStop();
    await report();

    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(
      await Promise.all(cancelAgent.mock.calls.map(([req]) => req.json())),
    ).toEqual([{ chatId: "chat", expectedTriggerRunId: "run_continued" }]);
    expect(events("agent_local_auto_continue_outcome")).toEqual([
      expect.objectContaining({
        outcome: "start_failed",
        reason: "start_error",
        continued_run_id: "run_continued",
      }),
    ]);
  });

  it("retries stopping a run the user stopped while it was starting", async () => {
    startAgent.mockImplementation(async () => {
      await cancelLocalAutoContinuesForChat({
        userId: "owner",
        chatId: "chat",
        reason: "user_stop",
      });
      return NextResponse.json({ runId: "run_continued" });
    });
    cancelAgent
      .mockResolvedValueOnce(new NextResponse("unavailable", { status: 503 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(NextResponse.json({ canceled: true }));
    await recordStop();
    await report();

    const bodies = await Promise.all(
      cancelAgent.mock.calls.map(([req]) => req.json()),
    );
    expect(bodies).toEqual(
      Array(3).fill({ chatId: "chat", expectedTriggerRunId: "run_continued" }),
    );
  });

  it("ignores a return reported for another user's connection", async () => {
    await recordStop();
    mockUserId.mockReturnValueOnce("intruder");
    await report();

    expect(startAgent).not.toHaveBeenCalled();
    expect(tables.agent_local_auto_continues[0].state).toBe("awaiting_return");
  });
});
