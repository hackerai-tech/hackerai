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

jest.mock("@trigger.dev/sdk", () => ({ tasks: { middleware: jest.fn() } }));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown) => ({ status: 200, json: async () => body }),
  },
}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: jest.fn().mockResolvedValue("owner"),
}));
jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("synthetic"),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { warn: jest.fn(), error: jest.fn() },
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
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  info = jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
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

it("reserves only two retries across concurrent reads and nested scopes", async () => {
  globalThis.fetch = jest.fn(async () => {
    throw reset();
  });
  const client = createServiceConvexClient(deployment);
  const results = await runWithServiceQueryRecovery(() =>
    Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runWithServiceQueryRecovery(() =>
          client.query(reference, { serviceKey: secret }),
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

it.each(["mutation", "action", "query_at_ts"])(
  "never replays %s, even with an eligible function name",
  async (endpoint) => {
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
            path: "localSandbox:listConnectionsForBackend",
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
