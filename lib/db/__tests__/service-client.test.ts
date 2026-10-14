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
