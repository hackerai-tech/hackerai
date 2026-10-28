import { webcrypto } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import {
  createServiceConvexClient,
  createServiceFetch,
} from "../service-client";
import { verifyServiceArgs } from "../service-proof";

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
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const secret = "synthetic-credential-for-client-tests";
const deployment = "https://fixture.convex.cloud";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each(["query", "mutation", "action"] as const)(
  "redacts %s SDK serialization failures before transport",
  async (type) => {
    const transport = jest.fn();
    globalThis.fetch = transport;
    const client = createServiceConvexClient(deployment);
    const reference = makeFunctionReference<typeof type>("fixture:accept");
    let message = "";
    try {
      await client[type](reference as never, {
        serviceKey: secret,
        parts: [undefined],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("undefined");
    expect(message).not.toContain(secret);
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(["query", "mutation", "action"] as const)(
  "signs real SDK %s wire arguments without changing results",
  async (type) => {
    let wire: Record<string, unknown> | undefined;
    globalThis.fetch = jest.fn(async (_input, init) => {
      wire = JSON.parse(String(init?.body)).args[0];
      return new Response(
        JSON.stringify({
          status: "success",
          value: { accepted: true },
          logLines: [],
        }),
      );
    });
    const client = createServiceConvexClient(deployment);
    const reference = makeFunctionReference<typeof type>("fixture:accept");
    await expect(
      client[type](reference as never, { serviceKey: secret, id: "control" }),
    ).resolves.toEqual({ accepted: true });
    expect(JSON.stringify(wire)).not.toContain(secret);
    expect(
      await verifyServiceArgs(
        { deployment, name: "fixture:accept", type },
        wire!,
        secret,
      ),
    ).toBe(true);
  },
);

it("preserves transient Cloudflare classification while removing credentials", async () => {
  globalThis.fetch = jest.fn(
    async () =>
      new Response(`<html>Cloudflare 520 upstream error ${secret}</html>`, {
        status: 520,
      }),
  );
  const client = createServiceConvexClient(deployment);
  const reference = makeFunctionReference<"query">("fixture:accept");
  const failure = await client
    .query(reference, { serviceKey: secret })
    .catch((error: Error) => error);
  expect(failure.message).toContain("Cloudflare 520");
  expect(failure.message).not.toContain(secret);
});

it("scrubs native validation diagnostics and SDK log lines before returning them", async () => {
  const transport = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "error",
          errorMessage: `ArgumentValidationError serviceKey: "${secret}"`,
          logLines: [`key ${secret}`],
        }),
      ),
  );
  const wrapped = createServiceFetch(deployment, transport);
  const response = await wrapped(`${deployment}/api/mutation`, {
    method: "POST",
    body: JSON.stringify({
      path: "fixture:accept",
      format: "convex_encoded_json",
      args: [{ serviceKey: secret }],
    }),
  });
  const text = await response.text();
  expect(text).toContain("ArgumentValidationError");
  expect(text).not.toContain(secret);
});

describe("bounded RPC failure diagnostics", () => {
  let warning: jest.SpyInstance;
  const diagnostics = (event = "convex_service_rpc_failed") =>
    warning.mock.calls.flatMap(([line]) => {
      try {
        const value = JSON.parse(String(line));
        return value.event === event ? [value] : [];
      } catch {
        return [];
      }
    });
  const request = (path = "fixture:accept") => ({
    method: "POST",
    headers: { authorization: "PRIVATE_HEADER" },
    body: JSON.stringify({
      path,
      format: "convex_encoded_json",
      args: [{ serviceKey: secret, target: "PRIVATE_TARGET" }],
    }),
  });
  beforeEach(() => {
    warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("attributes a real SDK failure while preserving signed arguments and redacted errors", async () => {
    let wire: Record<string, unknown> | undefined;
    globalThis.fetch = jest.fn(async (_input, init) => {
      wire = JSON.parse(String(init?.body)).args[0];
      return new Response(`Cloudflare 524 ${secret}`, { status: 524 });
    });
    const client = createServiceConvexClient(deployment);
    const failure = await client
      .query(makeFunctionReference<"query">("fixture:accept"), {
        serviceKey: secret,
        target: "PRIVATE_TARGET",
      })
      .catch((error: Error) => error);
    expect(failure.message).toContain("Cloudflare 524");
    expect(failure.message).not.toContain(secret);
    expect(
      await verifyServiceArgs(
        { deployment, name: "fixture:accept", type: "query" },
        wire!,
        secret,
      ),
    ).toBe(true);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        function_name: "fixture:accept",
        status_code: 524,
        reason: "http_5xx",
      }),
    ]);
    expect(JSON.stringify(diagnostics())).not.toMatch(
      /PRIVATE|synthetic-credential/,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([`${"a".repeat(129)}:accept`, `fixture:${secret}`])(
    "omits oversized or credential-bearing function labels",
    async (path) => {
      const failure = Object.assign(new Error("PRIVATE_ERROR"), {
        code: "PRIVATE_CODE",
      });
      await expect(
        createServiceFetch(deployment, jest.fn().mockRejectedValue(failure))(
          `${deployment}/api/query`,
          request(path),
        ),
      ).rejects.toBe(failure);
      expect(diagnostics()).toHaveLength(1);
      expect(diagnostics()[0]).not.toHaveProperty("function_name");
      expect(diagnostics()[0]).not.toHaveProperty("transport_code");
      expect(JSON.stringify(diagnostics())).not.toMatch(
        /PRIVATE|synthetic-credential/,
      );
    },
  );

  it.each(["query", "query_at_ts", "mutation", "action"])(
    "identifies one failed %s RPC without logging credentials or content",
    async (kind) => {
      const transport = jest.fn(
        async () =>
          new Response(`PRIVATE_BODY Cloudflare 524 ${secret}`, {
            status: 524,
          }),
      );
      const response = await createServiceFetch(deployment, transport)(
        `${deployment}/api/${kind}`,
        request(),
      );
      expect(response.status).toBe(524);
      expect(await response.text()).toBe(
        "PRIVATE_BODY Cloudflare 524 [Redacted]",
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(diagnostics()).toEqual([
        expect.objectContaining({
          rpc_kind: kind === "query_at_ts" ? "query" : kind,
          function_name: "fixture:accept",
          stage: "request",
          reason: "http_5xx",
          status_code: 524,
          transport_elapsed_ms: expect.any(Number),
        }),
      ]);
      const logged = JSON.stringify(diagnostics());
      for (const canary of [
        secret,
        "PRIVATE_TARGET",
        "PRIVATE_HEADER",
        "PRIVATE_BODY",
        deployment,
      ]) {
        expect(logged).not.toContain(canary);
      }
    },
  );

  it("preserves the exact transport rejection and omits an unsafe function label", async () => {
    const failure = new TypeError("PRIVATE_ERROR", {
      cause: Object.assign(new Error("PRIVATE_CAUSE"), { code: "ECONNRESET" }),
    });
    const transport = jest.fn().mockRejectedValue(failure);
    await expect(
      createServiceFetch(deployment, transport)(
        `${deployment}/api/query`,
        request("PRIVATE FUNCTION URL?secret"),
      ),
    ).rejects.toBe(failure);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        reason: "transport_error",
        stage: "request",
        transport_code: "ECONNRESET",
      }),
    ]);
    expect(diagnostics()[0]).not.toHaveProperty("function_name");
    expect(JSON.stringify(diagnostics())).not.toMatch(
      /PRIVATE|synthetic-credential/,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("identifies body-read failure and preserves the original error", async () => {
    const failure = Object.assign(new Error("PRIVATE_BODY_FAILURE"), {
      code: "UND_ERR_BODY_TIMEOUT",
    });
    const response = new Response("unused");
    jest.spyOn(response, "text").mockRejectedValue(failure);
    await expect(
      createServiceFetch(deployment, jest.fn().mockResolvedValue(response))(
        `${deployment}/api/action`,
        request(),
      ),
    ).rejects.toBe(failure);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        stage: "response_body",
        reason: "transport_error",
        transport_code: "UND_ERR_BODY_TIMEOUT",
      }),
    ]);
    expect(JSON.stringify(diagnostics())).not.toContain("PRIVATE_BODY_FAILURE");
  });

  it("attempts diagnostics once and preserves a 5xx body failure even if logging throws", async () => {
    const failure = new Error("original response failure");
    const response = new Response("unused", { status: 503 });
    jest.spyOn(response, "text").mockRejectedValue(failure);
    warning.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await expect(
      createServiceFetch(deployment, jest.fn().mockResolvedValue(response))(
        `${deployment}/api/query`,
        request(),
      ),
    ).rejects.toBe(failure);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each([200, 400, 403, 429])(
    "leaves HTTP%s quiet and unchanged",
    async (status) => {
      const response = await createServiceFetch(
        deployment,
        jest.fn().mockResolvedValue(new Response('{"value":"ok"}', { status })),
      )(`${deployment}/api/query`, request());
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('{"value":"ok"}');
      expect(warning).not.toHaveBeenCalled();
    },
  );

  describe("pending RPC diagnostics", () => {
    const pending = () => diagnostics("convex_service_rpc_pending");
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each(["fixture:accept", `fixture:${secret}`])(
      "reports one pending request without leaking the %s label or arguments",
      async (path) => {
        const started = deferred<void>();
        const headers = deferred<Response>();
        const body = deferred<string>();
        const readingBody = deferred<void>();
        const response = new Response("unused", { status: 201 });
        jest.spyOn(response, "text").mockImplementation(() => {
          readingBody.resolve();
          return body.promise;
        });
        const transport = jest.fn(() => {
          started.resolve();
          return headers.promise;
        });
        const result = createServiceFetch(deployment, transport)(
          `${deployment}/api/mutation`,
          request(path),
        );
        await started.promise;
        await jest.advanceTimersByTimeAsync(9999);
        expect(pending()).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        expect(pending()).toEqual([
          expect.objectContaining({
            rpc_kind: "mutation",
            stage: "request",
            transport_elapsed_ms: 10000,
          }),
        ]);
        expect(pending()[0]).not.toHaveProperty("status_code");
        if (path === "fixture:accept")
          expect(pending()[0].function_name).toBe(path);
        else expect(pending()[0]).not.toHaveProperty("function_name");
        headers.resolve(response);
        await readingBody.promise;
        await jest.advanceTimersByTimeAsync(20000);
        expect(pending()).toHaveLength(1);
        body.resolve("PRIVATE_BODY");
        const completed = await result;
        expect(jest.getTimerCount()).toBe(0);
        jest.useRealTimers();
        expect(completed.status).toBe(201);
        expect(await completed.text()).toBe("PRIVATE_BODY");
        expect(transport).toHaveBeenCalledTimes(1);
        for (const canary of [
          secret,
          "PRIVATE_TARGET",
          "PRIVATE_HEADER",
          "PRIVATE_BODY",
          deployment,
        ])
          expect(JSON.stringify(pending())).not.toContain(canary);
      },
    );

    it("identifies a pending response body after headers arrive", async () => {
      const body = deferred<string>();
      const readingBody = deferred<void>();
      const response = new Response("unused", { status: 200 });
      jest.spyOn(response, "text").mockImplementation(() => {
        readingBody.resolve();
        return body.promise;
      });
      const result = createServiceFetch(
        deployment,
        jest.fn().mockResolvedValue(response),
      )(`${deployment}/api/query`, request());
      await readingBody.promise;
      await jest.advanceTimersByTimeAsync(10000);
      expect(pending()).toEqual([
        expect.objectContaining({ stage: "response_body", status_code: 200 }),
      ]);
      body.resolve('{"value":"ok"}');
      const completed = await result;
      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
      expect(await completed.text()).toBe('{"value":"ok"}');
    });

    it.each(["success", "request_failure", "body_failure"])(
      "clears the timer after fast %s without changing the result",
      async (outcome) => {
        const failure = new Error("original transport failure");
        const response = new Response("unused");
        const read = jest.spyOn(response, "text");
        if (outcome === "body_failure") read.mockRejectedValue(failure);
        else read.mockResolvedValue('{"value":"ok"}');
        const transport = jest.fn();
        if (outcome === "request_failure") transport.mockRejectedValue(failure);
        else transport.mockResolvedValue(response);
        const result = createServiceFetch(deployment, transport)(
          `${deployment}/api/query`,
          request(),
        );
        let completed: Response | undefined;
        if (outcome === "success") completed = await result;
        else await expect(result).rejects.toBe(failure);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(20000);
        expect(pending()).toEqual([]);
        expect(transport).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
        if (completed) expect(await completed.text()).toBe('{"value":"ok"}');
      },
    );

    it("does not interrupt a pending RPC when its warning logger throws", async () => {
      const started = deferred<void>();
      const headers = deferred<Response>();
      const result = createServiceFetch(deployment, () => {
        started.resolve();
        return headers.promise;
      })(`${deployment}/api/query`, request());
      await started.promise;
      warning.mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      await jest.advanceTimersByTimeAsync(10000);
      expect(warning).toHaveBeenCalledTimes(1);
      const response = new Response("unused");
      jest.spyOn(response, "text").mockResolvedValue('{"value":"ok"}');
      headers.resolve(response);
      const completed = await result;
      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
      expect(await completed.text()).toBe('{"value":"ok"}');
    });
  });
});

it("cancels only the request-scoped client's in-flight transport", async () => {
  const controller = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  globalThis.fetch = jest.fn(async (_input, init) => {
    if (!init?.signal)
      return new Response(
        JSON.stringify({ status: "success", value: null, logLines: [] }),
      );
    connected();
    return new Promise<Response>((_resolve, reject) =>
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      ),
    );
  });
  const reference = makeFunctionReference<"mutation">("fixture:accept");
  const scoped = createServiceConvexClient(deployment, {
    signal: controller.signal,
  });
  const pending = scoped.mutation(reference, {});
  const rejected = expect(pending).rejects.toThrow("fixture deadline");
  await ready;
  controller.abort(new Error("fixture deadline"));
  await rejected;
  const ordinary = createServiceConvexClient(deployment);
  await expect(ordinary.mutation(reference, {})).resolves.toBeNull();
});

describe("SDK mutation wait diagnostics", () => {
  let warning: jest.SpyInstance;
  const observations = () =>
    warning.mock.calls.flatMap(([line]) => {
      const value = JSON.parse(String(line));
      return value.event === "convex_service_mutation_wait_pending"
        ? [value]
        : [];
    });
  const success = (value: string) =>
    new Response(JSON.stringify({ status: "success", value, logLines: [] }));
  beforeEach(() => {
    jest.useFakeTimers();
    warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("observes a real SDK follower before dispatch without bypassing its queue", async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connected!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const transport = jest
      .fn()
      .mockImplementationOnce(() => {
        connected();
        return held;
      })
      .mockImplementation(() => Promise.resolve(success("follower")));
    globalThis.fetch = transport;
    const client = createServiceConvexClient(deployment);
    const first = client.mutation(
      makeFunctionReference<"mutation">("fixture:held"),
      {
        serviceKey: secret,
        target: "PRIVATE_TARGET",
      },
    );
    await started;
    const second = client.mutation(
      makeFunctionReference<"mutation">("fixture:follower"),
      {
        serviceKey: secret,
        target: "PRIVATE_TARGET",
      },
    );
    try {
      await jest.advanceTimersByTimeAsync(10000);
      const follower = observations().find(
        (x) => x.function_name === "fixture:follower",
      );
      expect(follower).toEqual(
        expect.objectContaining({
          pending_mutations_at_start: 1,
          pending_mutations_now: 2,
          oldest_pending_function_name: "fixture:held",
          oldest_pending_elapsed_ms: 10000,
          sdk_elapsed_ms: 10000,
        }),
      );
      expect(follower.client_instance_id).toMatch(/^[a-f0-9-]{36}$/);
      const rpc = warning.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .find((x) => x.event === "convex_service_rpc_pending");
      expect(rpc.client_instance_id).toBe(follower.client_instance_id);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "PRIVATE_TARGET",
      );
    } finally {
      // The SDK consumes real Response streams after dispatch; keep that I/O
      // outside fake microtasks while still advancing the diagnostic deadline.
      jest.useRealTimers();
      release(success("head"));
      await expect(first).resolves.toBe("head");
      await expect(second).resolves.toBe("follower");
    }
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("bounds warning attempts in a rolling minute even when logging throws", async () => {
    jest.setSystemTime(0);
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connected!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    globalThis.fetch = jest
      .fn()
      .mockImplementationOnce(() => {
        connected();
        return held;
      })
      .mockImplementation(() => Promise.resolve(success("ok")));
    const client = createServiceConvexClient(deployment);
    const ref = makeFunctionReference<"mutation">("fixture:wait");
    const calls: Promise<unknown>[] = [];
    warning.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await jest.advanceTimersByTimeAsync(49000);
    calls.push(client.mutation(ref, {}));
    await started;
    calls.push(client.mutation(ref, {}));
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(observations()).toHaveLength(2);
      calls.push(client.mutation(ref, {}));
      await jest.advanceTimersByTimeAsync(10000);
      expect(observations()).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(50000);
      calls.push(client.mutation(ref, {}));
      await jest.advanceTimersByTimeAsync(10000);
      expect(observations()).toHaveLength(3);
      expect(observations()[2].pending_mutations_now).toBe(4);
    } finally {
      jest.useRealTimers();
      release(success("ok"));
      await expect(Promise.all(calls)).resolves.toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
    }
  });

  it("cleans up a rejected call before observing the next mutation", async () => {
    const failure = new Error("original failure");
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connected!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    globalThis.fetch = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => {
        connected();
        return held;
      });
    const client = createServiceConvexClient(deployment);
    await expect(
      client.mutation(makeFunctionReference<"mutation">("fixture:failed"), {}),
    ).rejects.toBe(failure);
    const next = client.mutation(
      makeFunctionReference<"mutation">("fixture:next"),
      {},
    );
    await started;
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(observations()).toEqual([
        expect.objectContaining({
          function_name: "fixture:next",
          pending_mutations_at_start: 0,
          pending_mutations_now: 1,
          oldest_pending_function_name: "fixture:next",
        }),
      ]);
    } finally {
      jest.useRealTimers();
      release(success("ok"));
      await expect(next).resolves.toBe("ok");
    }
  });

  it("preserves explicit skipQueue and clears fast-operation timers", async () => {
    jest.useRealTimers();
    const timers = jest.spyOn(globalThis, "setTimeout");
    const cleared = jest.spyOn(globalThis, "clearTimeout");
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connected!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    globalThis.fetch = jest
      .fn()
      .mockImplementationOnce(() => {
        connected();
        return held;
      })
      .mockImplementation(() => Promise.resolve(success("parallel")));
    const client = createServiceConvexClient(deployment);
    const first = client.mutation(
      makeFunctionReference<"mutation">("fixture:held"),
      {},
    );
    await started;
    try {
      await expect(
        client.mutation(
          makeFunctionReference<"mutation">("fixture:parallel"),
          {},
          { skipQueue: true },
        ),
      ).resolves.toBe("parallel");
    } finally {
      release(success("head"));
      await expect(first).resolves.toBe("head");
    }
    const diagnosticTimers = timers.mock.results.filter(
      (_r, i) => timers.mock.calls[i][1] === 10000,
    );
    expect(diagnosticTimers).toHaveLength(4);
    for (const timer of diagnosticTimers)
      expect(cleared).toHaveBeenCalledWith(timer.value);
    expect(observations()).toEqual([]);
  });

  it("keeps pending counts and correlation scoped to each client", async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connected!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let connections = 0;
    globalThis.fetch = jest.fn(() => {
      if (++connections === 2) connected();
      return held.then(() => success("ok"));
    });
    const ref = makeFunctionReference<"mutation">("fixture:wait");
    const calls = [
      createServiceConvexClient(deployment).mutation(ref, {}),
      createServiceConvexClient(deployment).mutation(ref, {}),
    ];
    await started;
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(observations()).toHaveLength(2);
      expect(
        new Set(observations().map((x) => x.client_instance_id)).size,
      ).toBe(2);
      expect(observations().map((x) => x.pending_mutations_now)).toEqual([
        1, 1,
      ]);
    } finally {
      jest.useRealTimers();
      release(success("unused"));
      await expect(Promise.all(calls)).resolves.toEqual(["ok", "ok"]);
    }
  });
});
