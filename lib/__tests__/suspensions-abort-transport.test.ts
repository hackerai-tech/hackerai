import { webcrypto } from "node:crypto";

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("convex/browser", () =>
  jest.requireActual("../../node_modules/convex/dist/cjs/browser/index.js"),
);
const { Response: FetchResponse } = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
Object.defineProperty(globalThis, "Response", {
  value: FetchResponse,
  configurable: true,
});
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const originalFetch = globalThis.fetch;
const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;
const clearResponse = () =>
  new Response(
    JSON.stringify({ status: "success", value: null, logLines: [] }),
  );

beforeEach(() => {
  jest.resetModules();
  process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-suspension-transport-key";
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
  jest.restoreAllMocks();
});

it.each([false, true])(
  "aborts a stalled signed suspension read and preserves unrelated reads (retry=%s)",
  async (stallRetry) => {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let transportSignal: AbortSignal | null | undefined;
    const transport = jest
      .fn<typeof fetch>()
      .mockResolvedValue(clearResponse());
    if (stallRetry)
      transport.mockRejectedValueOnce(new TypeError("fetch failed"));
    transport.mockImplementationOnce(async (_input, init) => {
      const wire = JSON.parse(String(init?.body));
      expect(wire.path).toBe("userSuspensions:getActiveByUser");
      expect(wire.args[0].userId).toBe("synthetic-user");
      expect(wire.args[0].serviceKey).toMatch(/^hmac1\./);
      transportSignal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(transportSignal?.reason);
        transportSignal?.addEventListener("abort", abort, { once: true });
        release = () => {
          transportSignal?.removeEventListener("abort", abort);
          resolve(clearResponse());
        };
        started();
      });
    });
    globalThis.fetch = transport;
    const { getConvexClient } = await import("../db/convex-client");
    const sharedClient = getConvexClient();
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    const controller = new AbortController();
    const result = assertUserCanMakeCostIncurringRequest("synthetic-user", {
      signal: controller.signal,
      retryNetworkFailure: true,
    });
    // Attach the rejection handler before aborting the live transport.
    const outcome = result.then(
      () => "incorrectly allowed",
      (error: Error) => error,
    );
    await pending;
    try {
      // Even an abort reason shaped like a retryable transport failure must
      // fail closed, without replenishing the existing one-retry budget.
      controller.abort(new TypeError("fetch failed"));
      expect(transportSignal?.aborted).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      expect(transport).toHaveBeenCalledTimes(stallRetry ? 2 : 1);
      expect(console.info).not.toHaveBeenCalled();

      expect(getConvexClient()).toBe(sharedClient);
      await expect(
        assertUserCanMakeCostIncurringRequest("unrelated-user"),
      ).resolves.toBeUndefined();
      expect(transport.mock.calls.at(-1)?.[1]?.signal?.aborted).not.toBe(true);
    } finally {
      release();
      await outcome;
    }
  },
);

it("does not dispatch an already aborted guard read", async () => {
  const transport = jest.fn<typeof fetch>().mockResolvedValue(clearResponse());
  globalThis.fetch = transport;
  const { assertUserCanMakeCostIncurringRequest } =
    await import("../suspensions");
  const controller = new AbortController();
  controller.abort(new Error("request deadline"));
  await expect(
    assertUserCanMakeCostIncurringRequest("synthetic-user", {
      signal: controller.signal,
      retryNetworkFailure: true,
    }),
  ).rejects.toThrow("request deadline");
  expect(transport).not.toHaveBeenCalled();
});

it("still blocks a live scoped read that returns an active suspension", async () => {
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "success",
        value: {
          status: "active",
          category: "dispute_billing_hold",
          source: "stripe",
          source_id: "synthetic-private-source",
        },
        logLines: [],
      }),
    ),
  );
  const { assertUserCanMakeCostIncurringRequest } =
    await import("../suspensions");
  await expect(
    assertUserCanMakeCostIncurringRequest("synthetic-user", {
      signal: new AbortController().signal,
      retryNetworkFailure: true,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});
