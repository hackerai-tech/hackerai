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
  const diagnostics = () =>
    warning.mock.calls.flatMap(([line]) => {
      try {
        const value = JSON.parse(String(line));
        return value.event === "convex_service_rpc_failed" ? [value] : [];
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
