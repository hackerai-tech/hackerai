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

  it("sends nothing without a signal or after settling", async () => {
    await expect(completeWaitOnStop(undefined, token).settle()).resolves.toBe(
      "not_sent",
    );
    const completion = completeWaitOnStop(stop.signal, token);
    await expect(completion.settle()).resolves.toBe("not_sent");
    stop.abort();
    stop.signal.dispatchEvent(new Event("abort"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes one attempt however often the stop is signalled", async () => {
    fetchMock.mockImplementation(async () => fakeResponse(503).response);
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    stop.signal.dispatchEvent(new Event("abort"));
    stop.signal.dispatchEvent(new Event("abort"));
    await responded();
    await expect(completion.settle()).resolves.toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
    const completion = completeWaitOnStop(stop.signal, {
      id: TOKEN_ID,
      url: url as string,
    });
    stop.abort();
    await expect(completion.settle()).resolves.toBe("invalid_callback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a token id that cannot be a single path segment", async () => {
    const id = "waitpoint/../x";
    const completion = completeWaitOnStop(stop.signal, {
      id,
      url: URL_FOR(id),
    });
    stop.abort();
    await expect(completion.settle()).resolves.toBe("invalid_callback");
    expect(fetchMock).not.toHaveBeenCalled();
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
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports unknown when fetch throws synchronously", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error(`invalid request ${URL_FOR()}`);
    });
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    await expect(completion.settle()).resolves.toBe("unknown");
  });

  it("aborts stalled response headers at its own deadline", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(stalledFetch);
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    const init = fetchMock.mock.calls[0][1] as any;

    await jest.advanceTimersByTimeAsync(9_999);
    expect(init.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(init.signal.aborted).toBe(true);
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

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
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    await jest.advanceTimersByTimeAsync(10_000);
    // The status arrived before the body stalled; it stays the result.
    await expect(completion.settle()).resolves.toBe("accepted");
    expect(body?.cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts and joins an in-flight request when the wait settles first", async () => {
    fetchMock.mockImplementation(stalledFetch);
    const completion = completeWaitOnStop(stop.signal, token);
    stop.abort();
    const init = fetchMock.mock.calls[0][1] as any;
    await expect(completion.settle()).resolves.toBe("unknown");
    expect(init.signal.aborted).toBe(true);
  });

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
