import type { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import "../../../trigger/init";
import { GET as presence } from "@/app/api/sandbox/presence/route";
import { transferableAbortController } from "node:util";
import { webcrypto } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import {
  createServiceConvexClient,
  createServiceFetch,
} from "../service-client";
import { runWithServiceQueryRecovery } from "../service-query-recovery.node";
import { verifyServiceArgs } from "../service-proof";
import * as convexClient from "../convex-client";
import { BrowserSessions } from "@/lib/ai/tools/utils/browser-sessions";
import { phLogger } from "@/lib/posthog/server";
import type { ToolContext } from "@/types";

jest.mock("@trigger.dev/sdk", () => ({ tasks: { middleware: jest.fn() } }));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: jest.fn().mockResolvedValue("owner"),
  getUserIDAndPro: jest.fn().mockResolvedValue({
    userId: "owner",
    organizationId: "fixture-org",
    subscription: "pro",
  }),
}));
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../convex-client", () => {
  const actual = jest.requireActual("../convex-client");
  return { ...actual, getConvexClient: jest.fn(actual.getConvexClient) };
});
jest.mock("@/lib/cloud-recovery/service", () => ({
  recoveryView: jest.fn().mockResolvedValue({ status: "none" }),
  confirmRecovery: jest.fn(),
  reopenRecovery: jest.fn(),
}));
jest.mock("@/lib/cloud-recovery/store", () => ({ failConsent: jest.fn() }));
jest.mock("@/lib/ai/browser-handoff/server", () => ({
  BrowserPreviewUnavailable: class extends Error {},
  connectBrowserSandbox: jest.fn().mockResolvedValue({}),
  getActiveBrowserSessionName: jest.fn().mockResolvedValue("default"),
  captureBrowserFrame: jest.fn().mockResolvedValue({ image: "fixture-frame" }),
}));
jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("synthetic"),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { warn: jest.fn(), error: jest.fn(), event: jest.fn() },
}));
// Rollout-off paths, which never read history, are covered by the route/tool suites.
jest.mock("@/lib/findings/hunt-policy", () => ({
  isFindingHuntsEnabled: async () => true,
}));
jest.mock("@/lib/findings/retest-policy", () => ({
  isFindingRetestsEnabled: async () => true,
}));
// Report creation's model-based dedupe is unused by history reads.
jest.mock("@/lib/findings/semantic-dedupe", () => ({
  createFindingWithDedupe: jest.fn(),
}));
jest.mock("@/lib/centrifugo/presence-traffic", () => ({
  trackPresenceTraffic: jest.fn(() => () => {}),
}));
jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn() })),
}));
jest.mock("convex/browser", () =>
  jest.requireActual("../../../node_modules/convex/dist/cjs/browser/index.js"),
);
const { Response: FetchResponse } = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
Object.defineProperty(globalThis, "Response", {
  value: FetchResponse,
  configurable: true,
});
const nativeAbort = transferableAbortController();
Object.defineProperty(globalThis, "AbortController", {
  value: nativeAbort.constructor,
  configurable: true,
});
Object.defineProperty(globalThis, "AbortSignal", {
  value: nativeAbort.signal.constructor,
  configurable: true,
});
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const deployment = "https://fixture.convex.cloud";
const secret = "synthetic-read-recovery-credential";
const reference = makeFunctionReference<"query">(
  "localSandbox:listConnectionsForBackend",
);
const originalFetch = globalThis.fetch;
const reset = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("read reset"), { code: "ECONNRESET" }),
  });
const success = () =>
  new Response(
    JSON.stringify({
      status: "success",
      value: [{ connectionId: "owned", online: false }],
      logLines: [],
    }),
  );
const registeredMiddleware = (tasks.middleware as jest.Mock).mock.calls[0]?.[1];
let warn: jest.SpyInstance;
let info: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  info = jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

it("counts an SDK-retried browser state query as one logical successful read", async () => {
  let stateAttempts = 0;
  globalThis.fetch = jest.fn(async (_url, init) => {
    const { path } = JSON.parse(String(init?.body));
    let value: unknown = null;
    if (path === "browserHandoffs:registerForBackend") value = true;
    if (path === "browserHandoffs:getForBackend") {
      if (++stateAttempts === 1) throw reset();
      value = { state: "agent", runActive: true };
    }
    return new Response(
      JSON.stringify({ status: "success", value, logLines: [] }),
    );
  });
  const client = createServiceConvexClient(deployment);
  jest
    .mocked(convexClient.getConvexClient)
    .mockReturnValueOnce(client)
    .mockReturnValueOnce(client)
    .mockReturnValueOnce(client);
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run_fixture",
    agentId: "parent",
    serviceKey: secret,
  });
  await runWithServiceQueryRecovery(async () => {
    await sessions.prepare({
      sandboxId: "fixture",
      commands: { run: async () => ({ exitCode: 0, stdout: "/usr/bin" }) },
    } as any);
    await expect(sessions.waitForAgentControl()).resolves.toBe(false);
    await sessions.cleanup();
  });
  expect(stateAttempts).toBe(2);
  const summaries = info.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.event === "browser_handoff_read_summary");
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    state_read_calls: 1,
    state_read_succeeded: 1,
    state_read_rejected: 0,
    state_read_pending: 0,
  });
});

it("recovers an actual SDK read after a reset, retaining scoped proofs and its result", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = jest.fn(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)).args[0]);
    if (bodies.length === 1) throw reset();
    return success();
  });
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret, userId: "owner" }),
    ),
  ).resolves.toEqual([{ connectionId: "owned", online: false }]);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(
      await verifyServiceArgs(
        {
          deployment,
          name: "localSandbox:listConnectionsForBackend",
          type: "query",
        },
        body,
        secret,
      ),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain(secret);
  }
  expect(
    JSON.stringify([...warn.mock.calls, ...info.mock.calls]),
  ).not.toContain(secret);
});

// Exact pre-response request timeout admitted only for the signed goal read.
const timedOut = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
  });
const goalReference = makeFunctionReference<"query">(
  "agentGoals:getForBackend",
);

it.each([
  ["a reset", reset],
  ["a pre-response request timeout", timedOut],
])(
  "recovers a signed goal read after %s, preserving owner and chat arguments",
  async (_label, failure) => {
    const goal = { chatId: "owned-chat", status: "active", generation: 1 };
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = jest.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)).args[0]);
      if (bodies.length === 1) throw failure();
      return new Response(
        JSON.stringify({ status: "success", value: goal, logLines: [] }),
      );
    });
    const client = createServiceConvexClient(deployment);
    await expect(
      runWithServiceQueryRecovery(() =>
        client.query(goalReference, {
          serviceKey: secret,
          userId: "owner",
          chatId: "owned-chat",
        }),
      ),
    ).resolves.toEqual(goal);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ userId: "owner", chatId: "owned-chat" });
      expect(
        await verifyServiceArgs(
          { deployment, name: "agentGoals:getForBackend", type: "query" },
          body,
          secret,
        ),
      ).toBe(true);
    }
    expect(
      jsonEvents()
        .filter((entry) => entry.event === "convex_service_query_recovery")
        .map((entry) => entry.outcome),
    ).toEqual(["scheduled", "response_received"]);
    expect(
      JSON.stringify([...warn.mock.calls, ...info.mock.calls]),
    ).not.toContain(secret);
  },
);

const terminatedBody = () => {
  const response = new Response('{"status":"success","value":');
  jest.spyOn(response, "text").mockRejectedValue(
    new TypeError("terminated", {
      cause: Object.assign(new Error("read reset"), { code: "ECONNRESET" }),
    }),
  );
  return response;
};

const jsonEvents = (): Record<string, unknown>[] =>
  [...warn.mock.calls, ...info.mock.calls].flatMap(([line]) => {
    try {
      const parsed = JSON.parse(String(line));
      return parsed && typeof parsed === "object" ? [parsed] : [];
    } catch {
      return [];
    }
  });

const loadChatReader = async () => {
  const priorKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  try {
    process.env.CONVEX_SERVICE_ROLE_KEY = secret;
    return (await import("../actions")).getChatById;
  } finally {
    if (priorKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = priorKey;
  }
};

it("recovers a terminated chat body through the real helper and native SDK", async () => {
  const getChatById = await loadChatReader();
  const id = "00000000-0000-4000-8000-000000000001";
  const bodies: Record<string, unknown>[] = [];
  const chat = { id, user_id: "owner", title: "owned", update_time: 1 };
  globalThis.fetch = jest.fn(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)).args[0]);
    if (bodies.length === 1) return terminatedBody();
    return new Response(
      JSON.stringify({ status: "success", value: chat, logLines: [] }),
    );
  });
  jest
    .mocked(convexClient.getConvexClient)
    .mockReturnValueOnce(createServiceConvexClient(deployment));
  await expect(
    runWithServiceQueryRecovery(() => getChatById({ id })),
  ).resolves.toEqual(chat);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body.id).toBe(id);
    expect(
      await verifyServiceArgs(
        { deployment, name: "chats:getChatById", type: "query" },
        body,
        secret,
      ),
    ).toBe(true);
  }
  expect(
    JSON.stringify([...warn.mock.calls, ...info.mock.calls]),
  ).not.toContain(secret);
});

it("caps terminated chat reads at two shared extra attempts across helper calls", async () => {
  const getChatById = await loadChatReader();
  globalThis.fetch = jest.fn(async () => terminatedBody());
  const client = createServiceConvexClient(deployment);
  for (let index = 0; index < 4; index++)
    jest.mocked(convexClient.getConvexClient).mockReturnValueOnce(client);
  const results = await runWithServiceQueryRecovery(() =>
    Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        runWithServiceQueryRecovery(() => getChatById({ id: String(index) })),
      ),
    ),
  );
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  const events = jsonEvents();
  expect(
    events.filter(
      (entry) =>
        entry.event === "convex_service_query_recovery" &&
        entry.outcome === "scheduled",
    ),
  ).toHaveLength(2);
  expect(
    events.filter((entry) => entry.event === "chat_fetch_retry_scheduled"),
  ).toEqual([]);
});

it("keeps the helper's terminated-body retries for a chat read outside any scope", async () => {
  const getChatById = await loadChatReader();
  const id = "00000000-0000-4000-8000-000000000002";
  const chat = { id, user_id: "owner", title: "owned", update_time: 1 };
  let calls = 0;
  globalThis.fetch = jest.fn(async () =>
    ++calls <= 2
      ? terminatedBody()
      : new Response(
          JSON.stringify({ status: "success", value: chat, logLines: [] }),
        ),
  );
  await expect(getChatById({ id })).resolves.toEqual(chat);
  expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  const events = jsonEvents();
  expect(
    events
      .filter((entry) => entry.event === "chat_fetch_retry_scheduled")
      .map((entry) => entry.retry_reason),
  ).toEqual(["network_response_terminated", "network_response_terminated"]);
  expect(
    events.filter((entry) => entry.event === "convex_service_query_recovery"),
  ).toEqual([]);
});

it("reserves only two retries across concurrent reads and nested scopes", async () => {
  globalThis.fetch = jest.fn(async () => {
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  const results = await runWithServiceQueryRecovery(() =>
    Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        runWithServiceQueryRecovery(() =>
          client.query(
            [
              reference,
              makeFunctionReference<"query">("agentGoals:getForBackend"),
              makeFunctionReference<"query">("chats:getChatById"),
            ][index % 3],
            { serviceKey: secret },
          ),
        ),
      ),
    ),
  );
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(7);
});

it("limits each RPC to one retry even when the run has another credit", async () => {
  const failure = reset();
  globalThis.fetch = jest.fn(async () => {
    throw failure;
  });
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).rejects.toBe(failure);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it.each(
  ["mutation", "action", "query_at_ts"].flatMap((endpoint) =>
    [
      "localSandbox:listConnectionsForBackend",
      "agentGoals:getForBackend",
      "chats:getChatById",
      "findingHunts:getHistoryForBackend",
      "findingAgentRetests:getHistoryForBackend",
    ].map((name) => [endpoint, name]),
  ),
)(
  "never replays %s, even with eligible function %s",
  async (endpoint, name) => {
    const failure = reset();
    const transport = jest.fn(async () => {
      throw failure;
    });
    const fetch = createServiceFetch(deployment, transport);
    await expect(
      runWithServiceQueryRecovery(() =>
        fetch(`${deployment}/api/${endpoint}`, {
          method: "POST",
          body: JSON.stringify({
            path: name,
            format: "convex_encoded_json",
            args: [{}],
          }),
        }),
      ),
    ).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["fixture:other", reset()],
  [
    "localSandbox:listConnectionsForBackend",
    Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
  ],
  [
    "localSandbox:listConnectionsForBackend",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    }),
  ],
])(
  "preserves non-eligible failures without a retry (%s)",
  async (name, failure) => {
    globalThis.fetch = jest.fn(async () => {
      throw failure;
    });
    const client = createServiceConvexClient(deployment);
    await expect(
      runWithServiceQueryRecovery(() =>
        client.query(makeFunctionReference<"query">(name as string), {
          serviceKey: secret,
        }),
      ),
    ).rejects.toBe(failure);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  },
);

it("does not retry application/access rejections or HTTP failures", async () => {
  globalThis.fetch = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "error",
          errorMessage: "Access denied",
          logLines: [],
        }),
      ),
  );
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).rejects.toThrow("Access denied");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  (globalThis.fetch as jest.Mock).mockImplementation(
    async () => new Response("Service unavailable", { status: 503 }),
  );
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).rejects.toThrow("Service unavailable");
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it("does not retry outside an owning request/run scope", async () => {
  globalThis.fetch = jest.fn(async () => {
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  await expect(client.query(reference, { serviceKey: secret })).rejects.toThrow(
    "fetch failed",
  );
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

const historyQueries = [
  "findingHunts:getHistoryForBackend",
  "findingAgentRetests:getHistoryForBackend",
];
const historyArgs = {
  serviceKey: secret,
  userId: "owner",
  findingId: "finding-fixture",
};
const throwing = (error: Error) => async () => {
  throw error;
};
const backendError = (errorMessage: string) => async () =>
  new Response(JSON.stringify({ status: "error", errorMessage, logLines: [] }));

it.each(
  historyQueries.flatMap((name) =>
    (
      [
        ["HTTP 401", async () => new Response("Unauthorized", { status: 401 })],
        ["HTTP 403", async () => new Response("Forbidden", { status: 403 })],
        ["HTTP 429", async () => new Response("Too many", { status: 429 })],
        ["HTTP 500", async () => new Response("Server error", { status: 500 })],
        ["an access rejection", backendError("Access denied")],
        ["a suspension rejection", backendError("Account suspended")],
        ["a deletion rejection", backendError("User deleted")],
        [
          "ETIMEDOUT",
          throwing(
            new TypeError("fetch failed", {
              cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
            }),
          ),
        ],
        ["an unrelated TypeError", throwing(new TypeError("Invalid input"))],
      ] as const
    ).map(([label, respond]) => [name, label, respond] as const),
  ),
)("sends %s once after %s", async (name, _label, respond) => {
  globalThis.fetch = jest.fn(respond);
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(makeFunctionReference<"query">(name), historyArgs),
    ),
  ).rejects.toThrow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it.each(historyQueries)(
  "does not retry %s outside an owning request/run scope",
  async (name) => {
    globalThis.fetch = jest.fn(throwing(reset()));
    const client = createServiceConvexClient(deployment);
    await expect(
      client.query(makeFunctionReference<"query">(name), historyArgs),
    ).rejects.toThrow("fetch failed");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  },
);

const withTimeoutCause = (code: string) =>
  Object.assign(new Error("timeout"), { code });
it.each([
  ["chats:getChatById", "request", timedOut()],
  ["userSuspensions:getActiveByUser", "request", timedOut()],
  ["agentGoals:getForBackend", "HTTP 200 body", timedOut()],
  [
    "agentGoals:getForBackend",
    "HTTP 200 body",
    new TypeError("terminated", { cause: withTimeoutCause("ETIMEDOUT") }),
  ],
  [
    "agentGoals:getForBackend",
    "request",
    new TypeError("terminated", { cause: withTimeoutCause("ETIMEDOUT") }),
  ],
  [
    "agentGoals:getForBackend",
    "request",
    new Error("fetch failed", { cause: withTimeoutCause("ETIMEDOUT") }),
  ],
  [
    "agentGoals:getForBackend",
    "request",
    Object.assign(new TypeError("fetch failed"), { code: "ETIMEDOUT" }),
  ],
  [
    "agentGoals:getForBackend",
    "request",
    new TypeError("fetch failed", {
      cause: withTimeoutCause("UND_ERR_CONNECT_TIMEOUT"),
    }),
  ],
  [
    "agentGoals:getForBackend",
    "request",
    new DOMException("The operation timed out.", "TimeoutError"),
  ],
] as const)(
  "sends %s once after an ineligible %s timeout (%p)",
  async (name, stage, failure) => {
    globalThis.fetch = jest.fn(async () => {
      if (stage === "request") throw failure;
      const partial = new Response('{"status":"success","value":');
      jest.spyOn(partial, "text").mockRejectedValue(failure);
      return partial;
    });
    const client = createServiceConvexClient(deployment);
    await expect(
      runWithServiceQueryRecovery(() =>
        client.query(makeFunctionReference<"query">(name), {
          serviceKey: secret,
          userId: "owner",
          chatId: "owned-chat",
        }),
      ),
    ).rejects.toBe(failure);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  },
);

it.each(["mutation", "action", "query_at_ts"])(
  "never replays a goal %s after a request timeout",
  async (endpoint) => {
    const failure = timedOut();
    const transport = jest.fn(throwing(failure));
    const fetch = createServiceFetch(deployment, transport);
    await expect(
      runWithServiceQueryRecovery(() =>
        fetch(`${deployment}/api/${endpoint}`, {
          method: "POST",
          body: JSON.stringify({
            path: "agentGoals:getForBackend",
            format: "convex_encoded_json",
            args: [{}],
          }),
        }),
      ),
    ).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it("shares two extra reads between goal timeouts and other resets across nested scopes", async () => {
  globalThis.fetch = jest.fn(async (_url, init) => {
    const { path } = JSON.parse(String(init?.body));
    throw path === "agentGoals:getForBackend" ? timedOut() : reset();
  });
  const client = createServiceConvexClient(deployment);
  // Three goal timeouts and one reset: without goal admission only the reset
  // could recover (5 sends); a per-goal allowance would exceed 6.
  const reads = [
    ...["chat-a", "chat-b", "chat-c"].map(
      (chatId) => [goalReference, chatId] as const,
    ),
    [reference, "none"] as const,
  ];
  const results = await runWithServiceQueryRecovery(() =>
    Promise.allSettled(
      reads.map(([query, chatId]) =>
        runWithServiceQueryRecovery(() =>
          client.query(query, { serviceKey: secret, userId: "owner", chatId }),
        ),
      ),
    ),
  );
  expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  const sends: Record<string, number> = {};
  for (const [, init] of (globalThis.fetch as jest.Mock).mock.calls) {
    const { path, args } = JSON.parse(String(init.body));
    const key = `${path}:${args[0].chatId}`;
    sends[key] = (sends[key] ?? 0) + 1;
  }
  expect(Object.keys(sends)).toHaveLength(4);
  expect(Math.max(...Object.values(sends))).toBe(2);
  // Each read still rejects with its own transport failure, not a substitute.
  expect(
    results.map((result) =>
      result.status === "rejected"
        ? [result.reason?.message, result.reason?.cause?.code]
        : result.status,
    ),
  ).toEqual([
    ["fetch failed", "ETIMEDOUT"],
    ["fetch failed", "ETIMEDOUT"],
    ["fetch failed", "ETIMEDOUT"],
    ["fetch failed", "ECONNRESET"],
  ]);
  expect(
    jsonEvents().filter(
      (entry) =>
        entry.event === "convex_service_query_recovery" &&
        entry.outcome === "scheduled",
    ),
  ).toHaveLength(2);
});

it("honors cancellation during backoff before issuing another request", async () => {
  const abort = new AbortController();
  globalThis.fetch = jest.fn(async () => {
    setTimeout(() => abort.abort(), 10);
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(
      () => client.query(reference, { serviceKey: secret }),
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it("does not recover a detached read after its scope has ended", async () => {
  let reject!: (error: unknown) => void;
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>((_resolve, fail) => {
        reject = fail;
        entered();
      }),
  );
  const client = createServiceConvexClient(deployment);
  let pending!: Promise<unknown>;
  await runWithServiceQueryRecovery(async () => {
    pending = client.query(reference, { serviceKey: secret });
    await dispatched;
  });
  reject(reset());
  await expect(pending).rejects.toThrow("fetch failed");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it("recovers a complete-body read reset without returning partial bytes", async () => {
  const partial = new Response('{"status":"success","value":');
  jest.spyOn(partial, "text").mockRejectedValue(
    new TypeError("terminated", {
      cause: Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      }),
    }),
  );
  globalThis.fetch = jest
    .fn()
    .mockResolvedValueOnce(partial)
    .mockResolvedValueOnce(success());
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).resolves.toEqual([{ connectionId: "owned", online: false }]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it("re-signs unsigned arguments when the first proof has expired", async () => {
  let now = 1_800_000_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = jest.fn(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)).args[0]);
    if (bodies.length === 1) {
      now += 61_000;
      throw reset();
    }
    return success();
  });
  const client = createServiceConvexClient(deployment);
  await runWithServiceQueryRecovery(() =>
    client.query(reference, { serviceKey: secret }),
  );
  const scope = {
    deployment,
    name: "localSandbox:listConnectionsForBackend",
    type: "query" as const,
  };
  expect(await verifyServiceArgs(scope, bodies[0], secret, now)).toBe(false);
  expect(await verifyServiceArgs(scope, bodies[1], secret, now)).toBe(true);
});

it("aborts a stalled retry body within its bounded deadline", async () => {
  globalThis.fetch = jest.fn(async (_url, init) => {
    if ((globalThis.fetch as jest.Mock).mock.calls.length === 1) throw reset();
    const response = new Response("incomplete");
    jest.spyOn(response, "text").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    return response;
  });
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).rejects.toThrow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(
    info.mock.calls.map(([line]) => JSON.parse(String(line))).at(-1),
  ).toMatchObject({ outcome: "canceled_or_deadline" });
});

it("honors a local reader's cancellation during recovery, not only the run signal", async () => {
  const local = new AbortController();
  globalThis.fetch = jest.fn(async () => {
    setTimeout(() => local.abort(), 10);
    throw reset();
  });
  const client = createServiceConvexClient(deployment, {
    signal: local.signal,
  });
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).rejects.toThrow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it("keeps separate concurrent HTTP/run budgets independent", async () => {
  globalThis.fetch = jest.fn(async () => {
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  await Promise.all(
    Array.from({ length: 2 }, () =>
      runWithServiceQueryRecovery(() =>
        Promise.allSettled(
          Array.from({ length: 3 }, () =>
            client.query(reference, { serviceKey: secret }),
          ),
        ),
      ),
    ),
  );
  expect(globalThis.fetch).toHaveBeenCalledTimes(10);
});

it("does not let diagnostic failure undo a recovered read", async () => {
  warn.mockImplementation(() => {
    throw new Error("logger offline");
  });
  info.mockImplementation(() => {
    throw new Error("logger offline");
  });
  globalThis.fetch = jest
    .fn()
    .mockRejectedValueOnce(reset())
    .mockResolvedValueOnce(success());
  const client = createServiceConvexClient(deployment);
  await expect(
    runWithServiceQueryRecovery(() =>
      client.query(reference, { serviceKey: secret }),
    ),
  ).resolves.toEqual([{ connectionId: "owned", online: false }]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

it.each(["agent-long", "hackerai-subagent"])(
  "wires the %s middleware to the same SDK recovery path",
  async (task) => {
    const middleware = registeredMiddleware;
    globalThis.fetch = jest
      .fn()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(success());
    const client = createServiceConvexClient(deployment);
    let result;
    await middleware({
      task,
      signal: new AbortController().signal,
      next: async () => {
        result = await client.query(reference, { serviceKey: secret });
      },
    });
    expect(result).toEqual([{ connectionId: "owned", online: false }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  },
);

it("does not silently enable recovery in unrelated Trigger tasks", async () => {
  const middleware = registeredMiddleware;
  globalThis.fetch = jest.fn(async () => {
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  await expect(
    middleware({
      task: "pm-user-research",
      signal: new AbortController().signal,
      next: () => client.query(reference, { serviceKey: secret }),
    }),
  ).rejects.toThrow("fetch failed");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it("recovers the actual presence route's connection read and returns its result", async () => {
  const saved = {
    url: process.env.NEXT_PUBLIC_CONVEX_URL,
    key: process.env.CONVEX_SERVICE_ROLE_KEY,
    ws: process.env.CENTRIFUGO_WS_URL,
  };
  process.env.NEXT_PUBLIC_CONVEX_URL = deployment;
  process.env.CONVEX_SERVICE_ROLE_KEY = secret;
  process.env.CENTRIFUGO_WS_URL = "wss://fixture.invalid";
  globalThis.fetch = jest
    .fn()
    .mockRejectedValueOnce(reset())
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "success", value: [], logLines: [] }),
      ),
    );
  try {
    const result = await presence({
      signal: new AbortController().signal,
    } as NextRequest);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ connections: [], onlineCount: 0 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  } finally {
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_CONVEX_URL: saved.url,
      CONVEX_SERVICE_ROLE_KEY: saved.key,
      CENTRIFUGO_WS_URL: saved.ws,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

const rpcValue = (value: unknown) =>
  new Response(JSON.stringify({ status: "success", value, logLines: [] }));
const historyFinding = {
  finding_id: "finding-fixture",
  chat_id: "chat-fixture",
  chat_title: "Fixture chat",
  updated_at: 1,
};
const huntView = {
  hunt_id: "hunt-fixture",
  chat_id: "chat-fixture",
  assistant_message_id: "message-fixture",
  status: "finished",
  started_at: 1,
  summary: "Fixture summary",
  candidates: [{ surface: "GET /fixture", outcome: "inconclusive" }],
};
const retestView = {
  retest_id: "retest-fixture",
  chat_id: "chat-fixture",
  assistant_message_id: "message-fixture",
  status: "finished",
  outcome: "inconclusive",
  summary: "Fixture summary",
  limitations: ["Fixture limitation"],
  started_at: 1,
};

describe("read-only GET requests that own recovery", () => {
  let viewerGet: typeof import("@/app/api/agent/browser/[sessionId]/route").GET;
  let recoveryGet: typeof import("@/app/api/sandbox/recovery/route").GET;
  let huntsGet: typeof import("@/app/api/finding-hunts/route").GET;
  let retestsGet: typeof import("@/app/api/finding-retests/route").GET;
  let restoreClientUrl: string;
  const savedEnv = {
    url: process.env.NEXT_PUBLIC_CONVEX_URL,
    key: process.env.CONVEX_SERVICE_ROLE_KEY,
    vercel: process.env.VERCEL_ENV,
    environment: process.env.HACKERAI_ENVIRONMENT,
  };
  const sessionId = "a".repeat(32);
  type Reader = {
    name: string;
    functionName: string;
    path: string;
    args: Record<string, unknown>;
    omitted?: string[];
    value: unknown;
    expected: Record<string, unknown>;
    noStore?: true;
    failureStatus: number;
    deniedValue: unknown;
    deniedStatus: number;
    call: (request: NextRequest) => Promise<Response>;
  };
  const readers: Reader[] = [
    {
      name: "browser viewer",
      functionName: "browserHandoffs:getForBackend",
      path: `/api/agent/browser/${sessionId}`,
      args: { userId: "owner", sessionId },
      value: { sessionId, state: "agent" },
      expected: { state: "agent", frame: { image: "fixture-frame" } },
      failureStatus: 503,
      deniedValue: null,
      deniedStatus: 404,
      call: (request: NextRequest) =>
        viewerGet(request, { params: Promise.resolve({ sessionId }) }),
    },
    {
      name: "recovery status",
      functionName: "userSuspensions:getActiveByUser",
      path: "/api/sandbox/recovery",
      args: { userId: "owner" },
      value: null,
      expected: { status: "none" },
      failureStatus: 409,
      deniedValue: {
        category: "policy",
        source: "manual",
        source_id: "fixture",
      },
      deniedStatus: 403,
      call: (request: NextRequest) => recoveryGet(request),
    },
    // History routes keep the backend's default bound and no chat restriction.
    {
      name: "finding hunt history",
      functionName: "findingHunts:getHistoryForBackend",
      path: "/api/finding-hunts?findingId=finding-fixture",
      args: { userId: "owner", findingId: "finding-fixture" },
      omitted: ["chatId", "limit", "signal"],
      value: { available: true, finding: historyFinding, hunts: [huntView] },
      expected: {
        enabled: true,
        chat_title: "Fixture chat",
        hunts: [huntView],
      },
      noStore: true,
      failureStatus: 503,
      deniedValue: { available: false },
      deniedStatus: 404,
      call: (request: NextRequest) => huntsGet(request),
    },
    {
      name: "finding retest history",
      functionName: "findingAgentRetests:getHistoryForBackend",
      path: "/api/finding-retests?findingId=finding-fixture",
      args: { userId: "owner", findingId: "finding-fixture" },
      omitted: ["chatId", "limit", "signal"],
      value: {
        available: true,
        finding: historyFinding,
        retests: [retestView],
      },
      expected: {
        enabled: true,
        chat_title: "Fixture chat",
        retests: [retestView],
      },
      noStore: true,
      failureStatus: 503,
      deniedValue: { available: false },
      deniedStatus: 404,
      call: (request: NextRequest) => retestsGet(request),
    },
  ];
  beforeAll(async () => {
    const { getConvexUrl } = await import("../convex-client");
    restoreClientUrl = getConvexUrl();
    process.env.NEXT_PUBLIC_CONVEX_URL = deployment;
    process.env.CONVEX_SERVICE_ROLE_KEY = secret;
    process.env.VERCEL_ENV = "preview";
    process.env.HACKERAI_ENVIRONMENT = "preview";
    viewerGet = (await import("@/app/api/agent/browser/[sessionId]/route")).GET;
    recoveryGet = (await import("@/app/api/sandbox/recovery/route")).GET;
    huntsGet = (await import("@/app/api/finding-hunts/route")).GET;
    retestsGet = (await import("@/app/api/finding-retests/route")).GET;
  });
  afterAll(async () => {
    const { setConvexUrl } = await import("../convex-client");
    setConvexUrl(restoreClientUrl);
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_CONVEX_URL: savedEnv.url,
      CONVEX_SERVICE_ROLE_KEY: savedEnv.key,
      VERCEL_ENV: savedEnv.vercel,
      HACKERAI_ENVIRONMENT: savedEnv.environment,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const response = (value: unknown) =>
    new Response(JSON.stringify({ status: "success", value, logLines: [] }));
  async function call(
    reader: (typeof readers)[number],
    signal = new AbortController().signal,
  ) {
    // Give each request a client bound to that test's transport, as a fresh worker would.
    const { setConvexUrl } = await import("../convex-client");
    setConvexUrl(deployment);
    return reader.call({
      signal,
      nextUrl: new URL(reader.path, "https://preview.example"),
    } as NextRequest);
  }
  it.each(readers)(
    "recovers the $name SDK read and preserves request context",
    async (reader) => {
      globalThis.fetch = jest
        .fn()
        .mockRejectedValueOnce(reset())
        .mockResolvedValueOnce(response(reader.value));
      const result = await call(reader);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject(reader.expected);
      if (reader.noStore)
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      for (const [_url, init] of (globalThis.fetch as jest.Mock).mock.calls) {
        const body = JSON.parse(init.body);
        expect(body.path).toBe(reader.functionName);
        expect(body.args[0]).toMatchObject(reader.args);
        for (const name of reader.omitted ?? [])
          expect(body.args[0]).not.toHaveProperty(name);
        expect(
          await verifyServiceArgs(
            { deployment, name: reader.functionName, type: "query" },
            body.args[0],
            secret,
          ),
        ).toBe(true);
      }
    },
  );
  it.each(readers)(
    "keeps the $name denial after a recovered transport",
    async (reader) => {
      globalThis.fetch = jest
        .fn()
        .mockRejectedValueOnce(reset())
        .mockResolvedValueOnce(response(reader.deniedValue));
      expect((await call(reader)).status).toBe(reader.deniedStatus);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each(readers)(
    "preserves the $name failure after one exhausted retry",
    async (reader) => {
      globalThis.fetch = jest.fn().mockRejectedValue(reset());
      expect((await call(reader)).status).toBe(reader.failureStatus);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each(readers)(
    "does not retry the $name after its request is canceled",
    async (reader) => {
      const stop = new AbortController();
      globalThis.fetch = jest.fn(async () => {
        stop.abort();
        throw reset();
      });
      expect((await call(reader, stop.signal)).status).toBe(
        reader.failureStatus,
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("finding history tools inside one Agent run", () => {
  type Read = (signal: AbortSignal) => Promise<unknown>;
  let tools: Record<"hunt" | "retest", Read>;
  let restoreClientUrl: string;
  const savedEnv = {
    url: process.env.NEXT_PUBLIC_CONVEX_URL,
    key: process.env.CONVEX_SERVICE_ROLE_KEY,
  };
  const context = {
    userID: "owner",
    chatId: "chat-fixture",
    assistantMessageId: "message-fixture",
    triggerRunId: "run_fixture",
  } as ToolContext;
  const historyValue = (path: string) =>
    rpcValue(
      path === "findingHunts:getHistoryForBackend"
        ? { available: true, finding: historyFinding, hunts: [huntView] }
        : { available: true, finding: historyFinding, retests: [retestView] },
    );
  beforeAll(async () => {
    restoreClientUrl = convexClient.getConvexUrl();
    process.env.NEXT_PUBLIC_CONVEX_URL = deployment;
    process.env.CONVEX_SERVICE_ROLE_KEY = secret;
    const hunt = (
      await import("@/lib/ai/tools/finding-hunts")
    ).createGetFindingHunts(context);
    const retest = (
      await import("@/lib/ai/tools/finding-retests")
    ).createGetFindingRetests(context);
    const options = (abortSignal: AbortSignal) => ({
      toolCallId: "fixture-call",
      messages: [],
      abortSignal,
    });
    tools = {
      hunt: async (signal) =>
        hunt.execute!({ finding_id: "finding-fixture" }, options(signal)),
      retest: async (signal) =>
        retest.execute!({ finding_id: "finding-fixture" }, options(signal)),
    };
  });
  afterAll(() => {
    convexClient.setConvexUrl(restoreClientUrl);
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_CONVEX_URL: savedEnv.url,
      CONVEX_SERVICE_ROLE_KEY: savedEnv.key,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  beforeEach(() => jest.mocked(phLogger.error).mockClear());

  /** Rebuilds the shared client too, so any unscoped read would use this transport. */
  const transport = (
    respond: (
      path: string,
      attempt: number,
      init?: RequestInit,
    ) => Promise<Response>,
  ) => {
    const attempts: Record<string, number> = {};
    globalThis.fetch = jest.fn(async (_url, init) => {
      const { path } = JSON.parse(String(init?.body));
      attempts[path] = (attempts[path] ?? 0) + 1;
      return respond(path, attempts[path], init);
    });
    convexClient.setConvexUrl(deployment);
    return globalThis.fetch as jest.Mock;
  };
  const sendsByQuery = (fetch: jest.Mock) => {
    const sends: Record<string, number> = {};
    for (const [, init] of fetch.mock.calls) {
      const { path } = JSON.parse(String(init.body));
      sends[path] = (sends[path] ?? 0) + 1;
    }
    return sends;
  };
  const inRun = (next: () => Promise<void>, signal?: AbortSignal) =>
    registeredMiddleware({
      task: "agent-long",
      signal: signal ?? new AbortController().signal,
      next,
    });

  it("recovers both tools' reset reads with their source-chat arguments", async () => {
    const fetch = transport(async (path, attempt) => {
      if (attempt === 1) throw reset();
      return historyValue(path);
    });
    const signal = new AbortController().signal;
    let results: unknown[] = [];
    await inRun(async () => {
      results = await Promise.all([tools.hunt(signal), tools.retest(signal)]);
    });
    expect(results).toMatchObject([
      {
        success: true,
        hunts: [
          {
            status: "finished",
            summary: "Fixture summary",
            candidates: [{ surface: "GET /fixture", outcome: "inconclusive" }],
          },
        ],
      },
      {
        success: true,
        retests: [
          {
            status: "finished",
            outcome: "inconclusive",
            limitations: ["Fixture limitation"],
          },
        ],
      },
    ]);
    expect(sendsByQuery(fetch)).toEqual({
      "findingHunts:getHistoryForBackend": 2,
      "findingAgentRetests:getHistoryForBackend": 2,
    });
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(String(init.body));
      const { serviceKey: _proof, ...sent } = body.args[0];
      // The signal cancels the read; it is never sent.
      expect(sent).toEqual({
        userId: "owner",
        findingId: "finding-fixture",
        chatId: "chat-fixture",
        limit: 5,
      });
      expect(
        await verifyServiceArgs(
          { deployment, name: body.path, type: "query" },
          body.args[0],
          secret,
        ),
      ).toBe(true);
    }
    expect(phLogger.error).not.toHaveBeenCalled();
  });

  it("shares the run's two extra reads across hunt, retest and other eligible reads", async () => {
    const fetch = transport(throwing(reset()));
    const goals = createServiceConvexClient(deployment);
    const signal = new AbortController().signal;
    let results: PromiseSettledResult<unknown>[] = [];
    await inRun(async () => {
      results = await Promise.allSettled([
        tools.hunt(signal),
        tools.retest(signal),
        goals.query(
          makeFunctionReference<"query">("agentGoals:getForBackend"),
          { serviceKey: secret, userId: "owner", chatId: "chat-fixture" },
        ),
      ]);
    });
    // Three original sends plus at most two recoveries for the whole run, and
    // never more than one recovery for a single read.
    expect(fetch).toHaveBeenCalledTimes(5);
    const sends = sendsByQuery(fetch);
    expect(Object.keys(sends).sort()).toEqual([
      "agentGoals:getForBackend",
      "findingAgentRetests:getHistoryForBackend",
      "findingHunts:getHistoryForBackend",
    ]);
    expect(Math.max(...Object.values(sends))).toBe(2);
    expect(results).toMatchObject([
      { status: "fulfilled", value: { success: false, error: "general" } },
      { status: "fulfilled", value: { success: false, error: "general" } },
      { status: "rejected" },
    ]);
  });

  it.each([
    ["hunt", "retest"],
    ["retest", "hunt"],
  ] as const)(
    "does not retry a %s history read after only its tool call is canceled",
    async (canceled, later) => {
      const tool = new AbortController();
      const run = new AbortController();
      let sends = 0;
      const fetch = transport(async (_path, attempt) => {
        if (++sends === 1) {
          setTimeout(() => tool.abort(), 10);
          throw reset();
        }
        if (attempt === 1) throw reset();
        return rpcValue({ available: false });
      });
      let canceledOutcome: unknown = "pending";
      let laterOutcome: unknown;
      await inRun(async () => {
        canceledOutcome = await tools[canceled](tool.signal).then(
          () => "resolved",
          () => "rejected",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        // The run's remaining credit still recovers another reader's reset.
        laterOutcome = await tools[later](new AbortController().signal);
      }, run.signal);
      // The cancellation is rethrown, not reported as a tool failure.
      expect(canceledOutcome).toBe("rejected");
      expect(phLogger.error).not.toHaveBeenCalled();
      expect(run.signal.aborted).toBe(false);
      expect(laterOutcome).toMatchObject({
        success: false,
        error: "not_found",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["hunt", "retest"] as const)(
    "does not retry a %s history read after the run is canceled",
    async (name) => {
      const run = new AbortController();
      const fetch = transport(async () => {
        setTimeout(() => run.abort(), 10);
        throw reset();
      });
      let result: unknown;
      await inRun(async () => {
        result = await tools[name](new AbortController().signal);
      }, run.signal);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: false, error: "general" });
    },
  );

  it.each(["hunt", "retest"] as const)(
    "ends a stalled %s history retry body at the recovery deadline",
    async (name) => {
      const fetch = transport(async (_path, attempt, init) => {
        if (attempt === 1) throw reset();
        const stalled = new Response("incomplete");
        jest.spyOn(stalled, "text").mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              const signal = init!.signal!;
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        return stalled;
      });
      let result: unknown;
      await inRun(async () => {
        result = await tools[name](new AbortController().signal);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ success: false, error: "general" });
      expect(
        jsonEvents()
          .filter((entry) => entry.event === "convex_service_query_recovery")
          .map((entry) => entry.outcome),
      ).toEqual(["scheduled", "canceled_or_deadline"]);
    },
  );
});
