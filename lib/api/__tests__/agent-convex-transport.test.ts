/**
 * @jest-environment node
 */
// Agent start/status over the real Convex HTTP SDK, service client, mutation
// queue and fetch transport, against a local fixture deployment. External
// services (auth, Trigger.dev, Sessions) are controlled fakes at their
// boundaries; no live network or credentials are used.
import http from "node:http";
import type { AddressInfo } from "node:net";

jest.setTimeout(15_000);

jest.mock("convex/browser", () =>
  jest.requireActual("../../../node_modules/convex/dist/cjs/browser/index.js"),
);
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/chat/chat-processor", () => ({
  fixIncompleteMessageParts: (parts: unknown) => parts,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/goals/analytics", () => ({
  captureGoalLifecycle: jest.fn(async () => undefined),
}));
const mockGetUserIDAndPro = jest.fn();
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: jest.fn(async () => undefined),
  assertUserCanMakeCostIncurringRequest: jest.fn(async () => undefined),
}));
jest.mock("@/lib/experiments/regional-subscription-first.server", () => ({
  enforceRegionalSubscriptionFirst: jest.fn(async () => undefined),
  subscriptionFirstCountryFromRequest: () => undefined,
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  assertFreeAgentGates: jest.fn(),
  buildExtraUsageConfig: jest.fn(async () => undefined),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-routing", () => ({
  resolveCloudWorkspaceRegion: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  readCloudWorkspaceState: jest.fn(),
  assertCloudWorkspaceAvailable: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: class {},
}));
jest.mock("@/lib/ai/tools/utils/sandbox-fallback", () => ({
  assertLocalSandboxFallbackAllowed: jest.fn(),
  getSandboxWithFallbackGuard: jest.fn(),
}));
jest.mock("@/lib/utils/sandbox-file-utils", () => ({
  getUploadBasePath: jest.fn(),
  hasLocalDesktopSourcePaths: () => false,
  prepareLocalDesktopAttachmentsForTrigger: jest.fn(),
  rewriteSandboxFilePathsInMessages: jest.fn(),
  stripLocalDesktopSourcePaths: (messages: unknown) => messages,
  uploadSandboxFiles: jest.fn(),
}));
const mockTriggerTask = jest.fn();
const mockSessionsStart = jest.fn();
const mockRunsRetrieve = jest.fn();
jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class ApiError extends Error {},
  auth: {
    createPublicToken: async (options: {
      scopes: { read?: { runs: string[] } };
    }) => `public-token:${options.scopes.read?.runs[0] ?? "session"}`,
  },
  idempotencyKeys: { create: async (parts: string[]) => parts.join(":") },
  runs: { retrieve: (...args: unknown[]) => mockRunsRetrieve(...args) },
  sessions: { start: (...args: unknown[]) => mockSessionsStart(...args) },
  streams: {},
  tasks: { trigger: (...args: unknown[]) => mockTriggerTask(...args) },
}));
const mockCancelRun = jest.fn();
const mockCloseSession = jest.fn();
jest.mock("@/lib/api/agent-approval-session", () => ({
  AGENT_APPROVAL_PROTOCOL_VERSION: 2,
  AGENT_APPROVAL_TOKEN_EXPIRATION: "15m",
  cancelAgentTriggerRun: (...args: unknown[]) => mockCancelRun(...args),
  closeAgentApprovalSession: (...args: unknown[]) => mockCloseSession(...args),
}));

type Doc = Record<string, any>;
type Call = {
  kind: "query" | "mutation";
  path: string;
  args: Doc;
  /** Resolves when the client closes the connection before a response. */
  abandoned: Promise<void>;
  abandonedByClient: boolean;
};
type Stall = Call & {
  /** Execute the function now (as Convex may after the client gave up). */
  commit: () => unknown;
  respond: (value: unknown) => void;
};
type Plan = "stall" | "commit_and_drop_response" | undefined;

/** A minimal Convex deployment with only the functions these paths call. */
const createFixtureDeployment = () => {
  const chats = new Map<string, Doc>();
  const goals = new Map<string, Doc>();
  const calls: Call[] = [];
  const stalls: Stall[] = [];
  const waiters: Array<{
    match: (call: Call) => boolean;
    resolve: () => void;
  }> = [];
  let plan: (call: Call) => Plan = () => undefined;

  const execute = ({ path, args }: Call): unknown => {
    const chat = chats.get(args.chatId ?? args.id);
    switch (path) {
      case "chats:getChatById":
        return chat ? { ...chat } : null;
      case "userCustomization:getUserCustomizationForBackend":
        return null;
      case "chats:saveChat":
        chats.set(args.id, {
          _id: `doc-${args.id}`,
          _creationTime: 1,
          id: args.id,
          title: args.title,
          user_id: args.userId,
          update_time: 1,
        });
        return `doc-${args.id}`;
      case "messages:saveMessage":
        return null;
      case "chats:replaceActiveTriggerRun": {
        if (!chat) return "not_found";
        const current = chat.active_trigger_run_id ?? null;
        if (
          current !== null &&
          current !== args.triggerRunId &&
          current !== args.expectedRunId
        )
          return "stale";
        const previous = {
          previousRunId: current,
          previousApprovalSessionId:
            chat.active_agent_approval_session_id ?? null,
        };
        chat.active_trigger_run_id = args.triggerRunId;
        chat.active_agent_approval_session_id =
          args.approvalSessionId ?? undefined;
        return previous;
      }
      case "chats:setActiveTriggerRun":
        if (!chat) return "not_found";
        if (
          args.expectedRunId !== undefined &&
          chat.active_trigger_run_id !== args.expectedRunId
        )
          return "stale";
        chat.active_trigger_run_id = args.triggerRunId ?? undefined;
        return "updated";
      case "agentGoals:getForBackend":
        return goals.get(args.chatId) ?? null;
      case "agentGoals:control": {
        const goal = goals.get(args.chatId)!;
        if (args.generation !== goal.generation)
          throw new Error("Goal changed");
        goal.state = "queued";
        return goal;
      }
      case "agentGoals:associateStartedRun": {
        const goal = goals.get(args.chatId);
        if (!chat || !goal || goal.generation !== args.generation) return false;
        if (goal.activeRunId === args.runId)
          return chat.active_trigger_run_id === args.runId;
        if (goal.activeRunId || chat.active_trigger_run_id) return false;
        chat.active_trigger_run_id = args.runId;
        chat.active_agent_approval_session_id = args.approvalSessionId;
        return true;
      }
      case "agentGoals:finish": {
        const goal = goals.get(args.chatId);
        if (!goal || goal.activeRunId !== args.runId) return null;
        delete goal.activeRunId;
        goal.state = "failed";
        return goal;
      }
      case "agentGoals:failDispatch":
        goals.get(args.chatId)!.state = "failed";
        return null;
      default:
        throw new Error(`Unexpected fixture function ${path}`);
    }
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const wire = JSON.parse(body);
      let markAbandoned!: () => void;
      const call: Call = {
        kind: req.url?.endsWith("/api/mutation") ? "mutation" : "query",
        path: wire.path,
        args: wire.args[0],
        abandoned: new Promise((resolve) => (markAbandoned = resolve)),
        abandonedByClient: false,
      };
      res.on("close", () => {
        if (res.writableEnded) return;
        call.abandonedByClient = true;
        markAbandoned();
      });
      calls.push(call);
      const send = (value: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "success", value, logLines: [] }));
      };
      const decision = plan(call);
      for (const waiter of waiters.filter(({ match }) => match(call))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      if (decision === "stall") {
        // Body fully received; no status line or headers are ever written.
        stalls.push(
          Object.assign(call, {
            commit: () => execute(call),
            respond: send,
          }),
        );
        return;
      }
      let value: unknown;
      try {
        value = execute(call);
      } catch (error) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "error",
            errorMessage: (error as Error).message,
            logLines: [],
          }),
        );
        return;
      }
      if (decision === "commit_and_drop_response") {
        // The write committed; its response is lost on the connection.
        req.socket.destroy();
        return;
      }
      send(value);
    });
  });

  return {
    chats,
    goals,
    calls,
    stalls,
    server,
    setPlan: (next: (call: Call) => Plan) => {
      plan = next;
    },
    /** Resolve when a matching RPC has fully arrived at the deployment. */
    arrived: (match: (call: Call) => boolean) =>
      calls.some(match)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ match, resolve })),
    paths: () => calls.map(({ path }) => path),
    reset: () => {
      for (const stall of stalls.splice(0)) stall.respond(null);
      chats.clear();
      goals.clear();
      calls.length = 0;
      waiters.length = 0;
      plan = () => undefined;
    },
  };
};

const fixture = createFixtureDeployment();
let routes: {
  agentStatus: (req: Request) => Promise<Response>;
  agentLongStatus: (req: Request) => Promise<Response>;
  agentStart: (req: Request) => Promise<Response>;
};
let actions: typeof import("@/lib/db/actions");

const nodeFetch = globalThis.fetch;

beforeAll(async () => {
  // Node's fetch runs in Jest's outer realm, so its TypeError fails the
  // service client's `instanceof Error` check and gets rewrapped. Production
  // has one realm: rebuild the same TypeError (message and cause) here. The
  // request, its socket and abort behavior are still Node's real fetch.
  globalThis.fetch = (input, init) =>
    nodeFetch(input, init).catch((error: Error) => {
      throw error?.name === "TypeError"
        ? new TypeError(error.message, { cause: error.cause })
        : error;
    });
  await new Promise<void>((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = fixture.server.address() as AddressInfo;
  process.env.NEXT_PUBLIC_CONVEX_URL = `http://127.0.0.1:${port}`;
  // Read by the data layer at import time.
  process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-fixture-service-key";
  process.env.AGENT_RUN_CORRELATION_SECRET = "synthetic-correlation-secret";
  actions = require("@/lib/db/actions");
  routes = {
    agentStatus: require("@/app/api/agent/status/route").POST,
    agentLongStatus: require("@/app/api/agent-long/status/route").POST,
    agentStart: require("@/app/api/agent/route").POST,
  };
});

afterAll(async () => {
  globalThis.fetch = nodeFetch;
  fixture.reset();
  fixture.server.closeAllConnections();
  await new Promise((resolve) => fixture.server.close(resolve));
});

beforeEach(() => {
  fixture.reset();
  mockGetUserIDAndPro.mockResolvedValue({
    userId: "user-1",
    subscription: "pro",
  });
  // Trigger idempotency: the same key returns the same run, never a new one.
  mockTriggerTask.mockImplementation(
    async (
      _task: string,
      _payload: unknown,
      options: { idempotencyKey: string },
    ) => ({
      id: `run_${Buffer.from(options.idempotencyKey).toString("hex").slice(-24)}`,
    }),
  );
  mockCancelRun.mockResolvedValue(true);
  mockCloseSession.mockResolvedValue(true);
  for (const method of ["info", "warn", "error"] as const)
    jest.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const startBody = (chatId: string, extra: Record<string, unknown> = {}) => ({
  chatId,
  messages: [
    {
      id: `${chatId}-message`,
      role: "user",
      parts: [{ type: "text", text: "Synthetic request" }],
    },
  ],
  sandboxPreference: "desktop",
  agentPermissionMode: "full_access",
  ...extra,
});

/** Fake only timers owned by this process; real sockets keep running. */
const useDeadlineClock = () =>
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "hrtime"],
  });

describe("Agent status ownership read deadline", () => {
  it.each([
    ["/api/agent/status", "agentStatus"],
    ["/api/agent-long/status", "agentLongStatus"],
  ] as const)(
    "%s aborts a read whose response headers never arrive and stays retryable",
    async (url, route) => {
      fixture.chats.set("chat-1", {
        _id: "doc-chat-1",
        _creationTime: 1,
        id: "chat-1",
        title: "Synthetic",
        user_id: "user-1",
        update_time: 1,
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "session-1",
      });
      fixture.setPlan(({ path }) =>
        path === "chats:getChatById" ? "stall" : undefined,
      );
      useDeadlineClock();
      let settled = false;
      const pending = routes[route](
        post(`http://localhost${url}`, { chatId: "chat-1", runId: "run-1" }),
      ).finally(() => (settled = true));
      await fixture.arrived(({ path }) => path === "chats:getChatById");

      await jest.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const response = await pending;

      // The real connection was aborted, not merely raced and left open.
      await fixture.stalls[0].abandoned;
      expect(fixture.stalls[0].abandonedByClient).toBe(true);
      // A typed temporary failure the browser poller retries; never terminal.
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("terminal");
      // No unverified run data was read, and nothing was cleaned up.
      expect(mockRunsRetrieve).not.toHaveBeenCalled();
      expect(mockCloseSession).not.toHaveBeenCalled();
      expect(fixture.calls.filter(({ kind }) => kind === "mutation")).toEqual(
        [],
      );
      expect(fixture.chats.get("chat-1")).toMatchObject({
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "session-1",
      });
    },
  );
});

describe("Agent admission isolation from another chat's pending write", () => {
  it("completes chat B's admission while chat A's write is stalled on the shared client", async () => {
    fixture.setPlan(({ path, args }) =>
      path === "messages:saveMessage" && args.chatId === "chat-a"
        ? "stall"
        : undefined,
    );
    // An Ask/worker-style write for unrelated chat A holds the process
    // singleton's serial SDK mutation queue.
    let chatASettled = false;
    const chatA = actions
      .saveMessage({
        chatId: "chat-a",
        userId: "user-a",
        message: {
          id: "a-1",
          role: "user",
          parts: [{ type: "text", text: "A" }],
        },
      })
      .finally(() => (chatASettled = true));
    await fixture.arrived(
      ({ path, args }) =>
        path === "messages:saveMessage" && args.chatId === "chat-a",
    );
    // Control: a default-client write queues behind A and never reaches the
    // deployment, proving this fixture reproduces the shared-queue stall.
    let controlSettled = false;
    const control = actions
      .setActiveTriggerRun({
        chatId: "chat-b",
        triggerRunId: null,
        expectedRunId: "run-unrelated",
      })
      .finally(() => (controlSettled = true));

    const response = await routes.agentStart(
      post("http://localhost/api/agent", startBody("chat-b")),
    );

    expect(response.status).toBe(200);
    const handle = await response.json();
    expect(handle).toMatchObject({
      chatId: "chat-b",
      runId: expect.stringMatching(/^run_/),
      publicAccessToken: `public-token:${handle.runId}`,
    });
    // B reached each of its own writes, in admission order, while A stalled.
    expect(
      fixture.calls
        .filter(({ args }) => (args.chatId ?? args.id) === "chat-b")
        .map(({ path }) => path),
    ).toEqual([
      "chats:getChatById",
      "chats:saveChat",
      "messages:saveMessage",
      "chats:getChatById",
      "chats:replaceActiveTriggerRun",
    ]);
    expect(fixture.chats.get("chat-b")?.active_trigger_run_id).toBe(
      handle.runId,
    );
    expect(chatASettled).toBe(false);
    expect(controlSettled).toBe(false);
    expect(fixture.paths()).not.toContain("chats:setActiveTriggerRun");
    expect(mockTriggerTask).toHaveBeenCalledTimes(1);

    // Releasing A drains the shared queue unchanged.
    fixture.stalls[0].respond(null);
    await expect(chatA).resolves.toBeNull();
    await expect(control).resolves.toBe("stale");
  });
});

describe("Agent ordinary-chat owner read before dispatch", () => {
  it.each([
    ["Trigger task", "full_access"],
    ["approval Session", "ask_approval"],
  ])(
    "starts no %s when the owner read times out",
    async (_dispatch, agentPermissionMode) => {
      // Stall only the owner read after this admission saved its message.
      fixture.setPlan(({ path }) =>
        path === "chats:getChatById" &&
        fixture.paths().includes("messages:saveMessage")
          ? "stall"
          : undefined,
      );
      useDeadlineClock();
      let settled = false;
      const pending = routes
        .agentStart(
          post(
            "http://localhost/api/agent",
            startBody("chat-owner", { agentPermissionMode }),
          ),
        )
        .finally(() => (settled = true));
      await fixture.arrived(
        ({ path }) =>
          path === "chats:getChatById" &&
          fixture.paths().includes("messages:saveMessage"),
      );

      await jest.advanceTimersByTimeAsync(3_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const response = await pending;

      expect(response.status).toBe(503);
      await fixture.stalls[0].abandoned;
      expect(fixture.stalls[0].abandonedByClient).toBe(true);
      // Nothing started, so nothing can be orphaned or needs cleanup.
      expect(mockTriggerTask).not.toHaveBeenCalled();
      expect(mockSessionsStart).not.toHaveBeenCalled();
      expect(mockCancelRun).not.toHaveBeenCalled();
      expect(mockCloseSession).not.toHaveBeenCalled();
      // The saved message stays; no ownership write was attempted.
      expect(
        fixture.calls
          .filter(({ kind }) => kind === "mutation")
          .map(({ path }) => path),
      ).toEqual(["chats:saveChat", "messages:saveMessage"]);
      expect(fixture.chats.get("chat-owner")?.active_trigger_run_id).toBe(
        undefined,
      );
    },
  );
});

describe("Agent run association with a lost Convex response", () => {
  it("returns the original run after a committed association loses its response", async () => {
    fixture.setPlan(({ path }) =>
      path === "chats:replaceActiveTriggerRun"
        ? "commit_and_drop_response"
        : undefined,
    );

    const response = await routes.agentStart(
      post("http://localhost/api/agent", startBody("chat-c")),
    );

    expect(response.status).toBe(200);
    const handle = await response.json();
    expect(handle.publicAccessToken).toBe(`public-token:${handle.runId}`);
    expect(mockTriggerTask).toHaveBeenCalledTimes(1);
    expect(fixture.chats.get("chat-c")?.active_trigger_run_id).toBe(
      handle.runId,
    );
    // Verified by a later independent read, not a replayed write.
    expect(fixture.paths().slice(-2)).toEqual([
      "chats:replaceActiveTriggerRun",
      "chats:getChatById",
    ]);
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(fixture.paths()).not.toContain("chats:setActiveTriggerRun");
  });

  const seedGoalChat = (chatId: string) => {
    fixture.chats.set(chatId, {
      _id: `doc-${chatId}`,
      _creationTime: 1,
      id: chatId,
      title: "Synthetic goal",
      user_id: "user-1",
      update_time: 1,
    });
    fixture.goals.set(chatId, {
      _id: `goal-${chatId}`,
      _creationTime: 1,
      chatId,
      userId: "user-1",
      generation: 2,
      state: "paused",
      sandboxPreference: "desktop",
      permissionMode: "full_access",
      selectedModel: "auto",
    });
  };
  const goalResume = { goal: { action: "resume", expectedGeneration: 2 } };

  it("verifies the goal generation before returning a goal run whose association response was lost", async () => {
    seedGoalChat("chat-goal");
    fixture.setPlan(({ path }) =>
      path === "agentGoals:associateStartedRun"
        ? "commit_and_drop_response"
        : undefined,
    );

    const response = await routes.agentStart(
      post("http://localhost/api/agent", startBody("chat-goal", goalResume)),
    );

    expect(response.status).toBe(200);
    const { runId } = await response.json();
    expect(mockTriggerTask).toHaveBeenCalledWith(
      "agent-long",
      expect.objectContaining({ goalGeneration: 2 }),
      expect.anything(),
    );
    expect(fixture.paths().slice(-3)).toEqual([
      "agentGoals:associateStartedRun",
      "chats:getChatById",
      "agentGoals:getForBackend",
    ]);
    expect(fixture.chats.get("chat-goal")?.active_trigger_run_id).toBe(runId);
    // The worker keeps its queued generation: no dispatch failure or cleanup.
    expect(fixture.goals.get("chat-goal")?.state).toBe("queued");
    expect(fixture.paths()).not.toContain("agentGoals:failDispatch");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed goal run for reconnect when its write may still commit", async () => {
    seedGoalChat("chat-goal-pending");
    fixture.setPlan(({ path }) =>
      path === "agentGoals:associateStartedRun" ? "stall" : undefined,
    );
    useDeadlineClock();
    const pending = routes.agentStart(
      post(
        "http://localhost/api/agent",
        startBody("chat-goal-pending", goalResume),
      ),
    );
    await fixture.arrived(
      ({ path }) => path === "agentGoals:associateStartedRun",
    );
    await jest.advanceTimersByTimeAsync(6_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "offline:api",
      metadata: { agent_run_association: "unconfirmed" },
    });
    expect(fixture.stalls[0].abandonedByClient).toBe(true);
    expect(fixture.goals.get("chat-goal-pending")?.state).toBe("queued");
    expect(fixture.paths()).not.toContain("agentGoals:failDispatch");
    expect(fixture.paths()).not.toContain("chats:setActiveTriggerRun");
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockCloseSession).not.toHaveBeenCalled();
    // The write Convex executes later still finds an intact run to own.
    const { id: runId } = await mockTriggerTask.mock.results[0].value;
    fixture.stalls[0].commit();
    expect(fixture.chats.get("chat-goal-pending")?.active_trigger_run_id).toBe(
      runId,
    );
  });

  it("fails an inconclusive association safely and lets the same turn reconnect to its run", async () => {
    fixture.setPlan(({ path, args }) =>
      path === "chats:replaceActiveTriggerRun" && args.expectedRunId === null
        ? "stall"
        : undefined,
    );
    useDeadlineClock();
    const first = routes.agentStart(
      post("http://localhost/api/agent", startBody("chat-d")),
    );
    await fixture.arrived(
      ({ path }) => path === "chats:replaceActiveTriggerRun",
    );
    await jest.advanceTimersByTimeAsync(5_999);
    expect(fixture.stalls[0].abandonedByClient).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const response = await first;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "offline:api",
      metadata: { agent_run_association: "unconfirmed" },
    });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(fixture.paths()).not.toContain("chats:setActiveTriggerRun");

    // Convex executes the abandoned write after the route answered.
    fixture.stalls[0].commit();
    const { id: originalRunId } = await mockTriggerTask.mock.results[0].value;
    expect(fixture.chats.get("chat-d")?.active_trigger_run_id).toBe(
      originalRunId,
    );

    const retry = await routes.agentStart(
      post("http://localhost/api/agent", startBody("chat-d")),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ runId: originalRunId });
    // The same turn reuses Trigger's idempotency key, so no second run starts.
    expect(mockTriggerTask.mock.calls[1][2].idempotencyKey).toBe(
      mockTriggerTask.mock.calls[0][2].idempotencyKey,
    );
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(fixture.chats.get("chat-d")?.active_trigger_run_id).toBe(
      originalRunId,
    );
  });
});

describe("Goal lifecycle timing at Agent start", () => {
  afterEach(() => {
    require("@/lib/goals/analytics").captureGoalLifecycle.mockImplementation(
      async () => undefined,
    );
  });

  it("does not bound reconciliation, reservation or its analytics with the message persistence deadline", async () => {
    // A finished previous goal run that reconciliation must settle and clear.
    fixture.chats.set("chat-goal-slow", {
      _id: "doc-chat-goal-slow",
      _creationTime: 1,
      id: "chat-goal-slow",
      title: "Synthetic goal",
      user_id: "user-1",
      update_time: 1,
      active_trigger_run_id: "run-previous",
    });
    fixture.goals.set("chat-goal-slow", {
      _id: "goal-chat-goal-slow",
      _creationTime: 1,
      chatId: "chat-goal-slow",
      userId: "user-1",
      generation: 2,
      state: "running",
      activeRunId: "run-previous",
      sandboxPreference: "desktop",
      permissionMode: "full_access",
      selectedModel: "auto",
    });
    fixture.setPlan(({ path }) =>
      path === "agentGoals:control" ? "stall" : undefined,
    );
    useDeadlineClock();
    // Each slow step takes longer than the deadline that previously covered it.
    let retrieveStarted!: () => void;
    const retrieving = new Promise<void>(
      (resolve) => (retrieveStarted = resolve),
    );
    mockRunsRetrieve.mockImplementationOnce(() => {
      retrieveStarted();
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "FAILED",
              metadata: { chatId: "chat-goal-slow", userId: "user-1" },
            }),
          7_000,
        ),
      );
    });
    const { captureGoalLifecycle } = require("@/lib/goals/analytics");
    let analyticsStarted!: () => void;
    const analyzing = new Promise<void>(
      (resolve) => (analyticsStarted = resolve),
    );
    captureGoalLifecycle.mockImplementation(async (action: string) => {
      if (action !== "resumed") return;
      analyticsStarted();
      await new Promise((resolve) => setTimeout(resolve, 12_000));
    });

    const pending = routes.agentStart(
      post(
        "http://localhost/api/agent",
        startBody("chat-goal-slow", {
          goal: { action: "resume", expectedGeneration: 2 },
        }),
      ),
    );
    await retrieving;
    await jest.advanceTimersByTimeAsync(7_000);
    await fixture.arrived(({ path }) => path === "agentGoals:control");
    // Reconciliation settled and cleared the previous run before reserving.
    expect(fixture.goals.get("chat-goal-slow")?.activeRunId).toBeUndefined();
    expect(
      fixture.chats.get("chat-goal-slow")?.active_trigger_run_id,
    ).toBeUndefined();

    await jest.advanceTimersByTimeAsync(12_000);
    const reservation = fixture.stalls[0];
    expect(reservation.abandonedByClient).toBe(false);
    reservation.respond(reservation.commit());
    await analyzing;
    await jest.advanceTimersByTimeAsync(12_000);
    const response = await pending;

    expect(response.status).toBe(200);
    const { runId } = await response.json();
    expect(mockTriggerTask).toHaveBeenCalledWith(
      "agent-long",
      expect.objectContaining({ goalGeneration: 2 }),
      expect.anything(),
    );
    expect(fixture.chats.get("chat-goal-slow")?.active_trigger_run_id).toBe(
      runId,
    );
    expect(fixture.goals.get("chat-goal-slow")?.state).toBe("queued");
    expect(
      fixture.calls.some(({ abandonedByClient }) => abandonedByClient),
    ).toBe(false);
    expect(fixture.paths()).not.toContain("agentGoals:failDispatch");
  });
});
