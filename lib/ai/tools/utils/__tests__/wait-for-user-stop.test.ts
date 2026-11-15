/** @jest-environment node */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { context, ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { completeWaitOnStop } from "../wait-for-user-stop";

const TOKEN_ID = "waitpoint_cm1abc";
const HASH = "0f".repeat(32);
const URL_FOR = (id = TOKEN_ID, hash = HASH) =>
  `https://api.trigger.dev/api/v1/waitpoints/tokens/${id}/callback/${hash}`;
const token = { id: TOKEN_ID, url: URL_FOR() };

// A minimal synchronous context manager, so the test can observe the context
// active while fetch is called (the default no-op manager drops contexts).
let activeContext: Context = ROOT_CONTEXT;
beforeAll(() => {
  context.setGlobalContextManager({
    active: () => activeContext,
    with(ctx, fn, thisArg, ...args) {
      const previous = activeContext;
      activeContext = ctx;
      try {
        return fn.call(thisArg, ...args);
      } finally {
        activeContext = previous;
      }
    },
    bind: (_ctx, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  });
});
afterAll(() => {
  context.disable();
});

const originalFetch = globalThis.fetch;
let fetchMock: jest.Mock<any>;
let consoleSpies: jest.SpiedFunction<any>[];
let stop: AbortController;

/** A response whose body records whether it was read or discarded. */
function fakeResponse(status: number, cancel = async () => {}) {
  const body = { cancel: jest.fn(cancel) };
  const reads = {
    text: jest.fn(),
    json: jest.fn(),
    arrayBuffer: jest.fn(),
    blob: jest.fn(),
  };
  return {
    response: { ok: status >= 200 && status < 300, status, body, ...reads },
    body,
    reads,
  };
}

/** Let a request that already has its response finish before the wait settles. */
async function responded() {
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
}

/** The same, under fake timers, which also fake setImmediate. */
async function settledMicrotasks() {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

/** The closed receipt of a stopped completion, with nothing else in it. */
const receipt = (
  outcome: string,
  httpStatus: number | null,
  elapsedMs: unknown,
  abortSource: string | null,
) => ({ outcome, httpStatus, elapsedMs, abortSource });

function expectBoundedElapsed(report: any) {
  expect(Number.isInteger(report.elapsedMs)).toBe(true);
  expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(report.elapsedMs).toBeLessThanOrEqual(60_000);
}

/** A fetch that never answers until its own signal aborts, like a stalled peer. */
const stalledFetch = (_url: unknown, init: any) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(new Error(`stalled request to ${URL_FOR()}`)),
    );
  });

beforeEach(() => {
  stop = new AbortController();
  fetchMock = jest.fn(async () => fakeResponse(200).response);
  globalThis.fetch = fetchMock as any;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) => jest.spyOn(console, method),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // No capability URL, response or error may reach any log.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("completeWaitOnStop", () => {
  it("posts the closed marker once to this token's callback without tracing", async () => {
    let suppressed: boolean | undefined;
    fetchMock.mockImplementation(async () => {
      suppressed = isTracingSuppressed(context.active());
      return fakeResponse(200).response;
    });
    const completion = completeWaitOnStop(stop.signal, token);
    expect(fetchMock).not.toHaveBeenCalled();

    stop.abort(new Error("stopped"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(token.url);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
    });
    // A fixed byte body gives fetch an exact Content-Length.
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({
      type: "agent_wait_stopped",
    });
    expect(init.signal).not.toBe(stop.signal);
    expect(init.signal.aborted).toBe(false);
    expect(suppressed).toBe(true);
    expect(isTracingSuppressed(context.active())).toBe(false);

    await responded();
    expect(init.signal.aborted).toBe(false);
    await expect(completion.settle()).resolves.toBe("accepted");
  });

  it("starts immediately when the stop already fired", async () => {
    stop.abort();
    const completion = completeWaitOnStop(stop.signal, token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await responded();
    await expect(completion.settle()).resolves.toBe("accepted");
  });

  it("sends and reports nothing without a signal or after settling", async () => {
    const onReport = jest.fn();
    await expect(
      completeWaitOnStop(undefined, token, onReport).settle(),
    ).resolves.toBe("not_sent");
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    await expect(completion.settle()).resolves.toBe("not_sent");
    stop.abort();
    stop.signal.dispatchEvent(new Event("abort"));
    await responded();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });

  it("makes and reports one attempt however often the stop is signalled", async () => {
    fetchMock.mockImplementation(async () => fakeResponse(503).response);
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    stop.signal.dispatchEvent(new Event("abort"));
    stop.signal.dispatchEvent(new Event("abort"));
    await responded();
    await expect(completion.settle()).resolves.toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls[0][0]).toMatchObject({
      outcome: "rejected",
      httpStatus: 503,
    });
  });

  it.each([
    [202, "accepted", 202],
    [409, "rejected", 409],
    // A status fetch cannot express as HTTP (an opaque 0) is not reported.
    [0, "rejected", null],
  ] as const)(
    "reports an HTTP %s answer once while the original wait is still pending",
    async (status, outcome, httpStatus) => {
      jest.useFakeTimers();
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(fakeResponse(status).response), 1_234),
          ),
      );
      const onReport = jest.fn();
      const completion = completeWaitOnStop(stop.signal, token, onReport);
      stop.abort();
      await jest.advanceTimersByTimeAsync(1_233);
      await settledMicrotasks();
      expect(onReport).not.toHaveBeenCalled();

      // Reported as the request finishes, without waiting for settle().
      await jest.advanceTimersByTimeAsync(1);
      await settledMicrotasks();
      expect(onReport.mock.calls).toEqual([
        [receipt(outcome, httpStatus, 1_234, null)],
      ]);

      // Aborting a finished request must not relabel or repeat the receipt.
      await expect(completion.settle()).resolves.toBe(outcome);
      expect(onReport).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["plain HTTP", URL_FOR().replace("https:", "http:")],
    ["another host", URL_FOR().replace("api.trigger.dev", "evil.example")],
    ["a lookalike host", URL_FOR().replace("trigger.dev", "trigger.dev.evil")],
    ["a custom port", URL_FOR().replace("trigger.dev", "trigger.dev:8443")],
    ["credentials", URL_FOR().replace("https://", "https://user:pass@")],
    ["a query", `${URL_FOR()}?redirect=1`],
    ["a fragment", `${URL_FOR()}#x`],
    ["a trailing segment", `${URL_FOR()}/extra`],
    ["another token", URL_FOR("waitpoint_other")],
    ["another endpoint", URL_FOR().replace("/callback/", "/complete/")],
    ["an API version change", URL_FOR().replace("/v1/", "/v2/")],
    ["a traversal", URL_FOR(TOKEN_ID, `..%2F..%2F${HASH}`)],
    ["a short hash", URL_FOR(TOKEN_ID, "abc")],
    ["a missing hash", URL_FOR(TOKEN_ID, "")],
    ["a malformed URL", "not a url"],
    ["a non-string URL", undefined],
  ])("refuses a callback URL with %s", async (_case, url) => {
    const onReport = jest.fn();
    const completion = completeWaitOnStop(
      stop.signal,
      { id: TOKEN_ID, url: url as string },
      onReport,
    );
    stop.abort();
    // Reported on the stop itself, while the original wait is still pending.
    expect(onReport.mock.calls).toEqual([
      [receipt("invalid_callback", null, 0, null)],
    ]);
    await expect(completion.settle()).resolves.toBe("invalid_callback");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("refuses a token id that cannot be a single path segment", async () => {
    const id = "waitpoint/../x";
    const onReport = jest.fn();
    const completion = completeWaitOnStop(
      stop.signal,
      { id, url: URL_FOR(id) },
      onReport,
    );
    stop.abort();
    await expect(completion.settle()).resolves.toBe("invalid_callback");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReport.mock.calls).toEqual([
      [receipt("invalid_callback", null, 0, null)],
    ]);
  });

  it("discards a response body unread, whatever the status", async () => {
    for (const status of [200, 409, 500]) {
      const { response, body, reads } = fakeResponse(status, async () => {
        throw new Error("body cancel failed");
      });
      fetchMock.mockResolvedValueOnce(response);
      const signal = new AbortController();
      const completion = completeWaitOnStop(signal.signal, token);
      signal.abort();
      await responded();
      await expect(completion.settle()).resolves.toBe(
        status === 200 ? "accepted" : "rejected",
      );
      expect(body.cancel).toHaveBeenCalledTimes(1);
      for (const read of Object.values(reads))
        expect(read).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["the connection fails", new TypeError(`fetch failed: ${URL_FOR()}`)],
    ["a redirect is refused", new TypeError("unexpected redirect")],
  ])("reports unknown without retrying when %s", async (_case, error) => {
    fetchMock.mockRejectedValue(error);
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    await responded();
    // The receipt is closed: no URL, hash, token or error text.
    expect(onReport.mock.calls).toEqual([
      [receipt("unknown", null, expect.any(Number), null)],
    ]);
    expectBoundedElapsed(onReport.mock.calls[0][0]);
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("reports unknown when fetch throws synchronously", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error(`invalid request ${URL_FOR()}`);
    });
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(onReport.mock.calls).toEqual([
      [receipt("unknown", null, expect.any(Number), null)],
    ]);
  });

  it("aborts stalled response headers at its own deadline and reports it then", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(stalledFetch);
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    const init = fetchMock.mock.calls[0][1] as any;

    await jest.advanceTimersByTimeAsync(9_999);
    expect(init.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(init.signal.aborted).toBe(true);
    // Reported before the original wait settles; settle() keeps the source.
    await settledMicrotasks();
    expect(onReport.mock.calls).toEqual([
      [receipt("unknown", null, 10_000, "deadline")],
    ]);
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ["the original wait settles", "original_wait_settled"],
    ["the deadline passes", "deadline"],
  ] as const)(
    "keeps the first abort source when %s first and bounds the elapsed time",
    async (first, abortSource) => {
      jest.useFakeTimers();
      // A transport that does not honour abort, so both aborts land in flight.
      let finish!: (response: unknown) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const onReport = jest.fn();
      const completion = completeWaitOnStop(stop.signal, token, onReport);
      stop.abort();
      let joined: Promise<string> | undefined;
      if (first === "the original wait settles") joined = completion.settle();
      await jest.advanceTimersByTimeAsync(10_000);
      joined ??= completion.settle();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(onReport).not.toHaveBeenCalled();

      finish(fakeResponse(409).response);
      await expect(joined).resolves.toBe("rejected");
      expect(onReport.mock.calls).toEqual([
        [receipt("rejected", 409, 60_000, abortSource)],
      ]);
    },
  );

  it("aborts a stalled body at its deadline, as native fetch errors it", async () => {
    jest.useFakeTimers();
    let body: { cancel: jest.Mock<any> } | undefined;
    fetchMock.mockImplementation(async (_url: unknown, init: any) => {
      const fake = fakeResponse(
        200,
        () =>
          new Promise<void>((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new Error(`body aborted ${URL_FOR()}`)),
            ),
          ),
      );
      body = fake.body;
      return fake.response;
    });
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    await jest.advanceTimersByTimeAsync(10_000);
    // The status arrived before the body stalled; it stays the result.
    await expect(completion.settle()).resolves.toBe("accepted");
    expect(body?.cancel).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls).toEqual([
      [receipt("accepted", 200, 10_000, "deadline")],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts, joins and reports an in-flight request when the wait settles first", async () => {
    fetchMock.mockImplementation(stalledFetch);
    const onReport = jest.fn();
    const completion = completeWaitOnStop(stop.signal, token, onReport);
    stop.abort();
    const init = fetchMock.mock.calls[0][1] as any;
    expect(onReport).not.toHaveBeenCalled();
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(init.signal.aborted).toBe(true);
    expect(onReport.mock.calls).toEqual([
      [receipt("unknown", null, expect.any(Number), "original_wait_settled")],
    ]);
    expectBoundedElapsed(onReport.mock.calls[0][0]);
  });

  it.each([
    ["an invalid callback", { id: TOKEN_ID, url: "not a url" }, false],
    [
      "an invalid callback stopped before it starts",
      { id: TOKEN_ID, url: "not a url" },
      true,
    ],
    ["an accepted request", token, false],
  ])(
    "contains a throwing observer for %s",
    async (_case, callbackToken, stoppedFirst) => {
      const reason = new Error("local_connection_lost");
      if (stoppedFirst) stop.abort(reason);
      const onReport = jest.fn(() => {
        throw new Error("analytics unavailable");
      });
      const completion = completeWaitOnStop(
        stop.signal,
        callbackToken,
        onReport,
      );
      if (!stoppedFirst) stop.abort(reason);
      await responded();
      expect(onReport).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]?.[1] as any;
      // The request was neither aborted nor repeated by the observer failure.
      if (init) expect(init.signal.aborted).toBe(false);
      await expect(completion.settle()).resolves.toBe(
        callbackToken === token ? "accepted" : "invalid_callback",
      );
      expect(fetchMock).toHaveBeenCalledTimes(callbackToken === token ? 1 : 0);
      expect(stop.signal.reason).toBe(reason);
      expect(onReport).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps settle pending until its own request actually finishes", async () => {
    // A transport that does not honour abort: settle must not claim a join
    // before the request it owns has settled.
    let finish!: (response: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    let settled: string | undefined;
    const joined = completion.settle().then((outcome) => {
      settled = outcome;
    });
    await responded();
    expect((fetchMock.mock.calls[0][1] as any).signal.aborted).toBe(true);
    expect(settled).toBeUndefined();

    finish(fakeResponse(409).response);
    await joined;
    expect(settled).toBe("rejected");
  });
});
