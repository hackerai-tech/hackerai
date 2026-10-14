import { webcrypto } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { signServiceArgs, verifyServiceArgs } from "../../lib/db/service-proof";

jest.mock("../_generated/server", () => {
  const register = (definition: unknown) => definition;
  return {
    query: register,
    mutation: register,
    action: register,
    internalQuery: register,
    internalMutation: register,
    internalAction: register,
  };
});
import {
  query,
  mutation,
  action,
  serviceContext,
} from "../lib/serviceFunctions";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const secret = "synthetic-main-service-credential";
const researchSecret = "synthetic-research-credential";
const deployment = "https://fixture.convex.cloud";
const original = { ...process.env };
beforeEach(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = secret;
  process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = researchSecret;
  process.env.CONVEX_CLOUD_URL = deployment;
  delete process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL;
});
afterAll(() => {
  process.env = original;
});

const context = (name: string, type = "mutation") => ({
  meta: {
    getFunctionMetadata: async () => ({ name, type, componentPath: "" }),
  },
});

describe("service registration boundary", () => {
  it.each([
    [query, "query"],
    [mutation, "mutation"],
    [action, "action"],
  ] as const)(
    "keeps native validators and authenticates %s",
    async (builder, type) => {
      const handler = jest.fn(async (_ctx, args) => args.id);
      const args = { serviceKey: v.string(), id: v.string() };
      const returns = v.string();
      const registered = (builder as any)({ args, returns, handler });
      expect(registered.args).toBe(args);
      expect(registered.returns).toBe(returns);
      const scope = { name: "fixture:save", type, deployment };
      const signed = await signServiceArgs(scope, {
        serviceKey: secret,
        id: "id-1",
      });
      await expect(
        registered.handler(context(scope.name, type), signed),
      ).resolves.toBe("id-1");
      expect(handler.mock.calls[0][1].serviceKey).toBe(secret);
      await expect(
        registered.handler(context(scope.name, type), {
          serviceKey: secret,
          id: "id-1",
        }),
      ).rejects.toThrow("Invalid service request");
    },
  );

  it("does not give a research proof general service authority", async () => {
    const handler = jest.fn(async () => null);
    const registered = (mutation as any)({
      args: { serviceKey: v.string() },
      returns: v.null(),
      handler,
    });
    const name = "messages:saveMessage";
    const signed = await signServiceArgs(
      { deployment, name, type: "mutation" },
      { serviceKey: researchSecret },
    );
    await expect(registered.handler(context(name), signed)).rejects.toThrow(
      "Invalid service request",
    );
    expect(handler).not.toHaveBeenCalled();
    const researchName = "userResearch:createAnalysis";
    const allowed = await signServiceArgs(
      { deployment, name: researchName, type: "mutation" },
      { serviceKey: researchSecret },
    );
    await expect(
      registered.handler(context(researchName), allowed),
    ).resolves.toBeNull();
  });

  it("signs internal child calls again for their own destination and arguments", async () => {
    const runMutation = jest.fn(async () => null);
    const ctx = serviceContext({ runMutation } as any);
    const reference = makeFunctionReference<"mutation">("fixture:child");
    await ctx.runMutation(reference, { serviceKey: secret, id: "child-1" });
    const sent = runMutation.mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(
      await verifyServiceArgs(
        { deployment, name: "fixture:child", type: "mutation" },
        sent,
        secret,
      ),
    ).toBe(true);
  });

  it("preserves ordinary authenticated-user calls without a service credential", async () => {
    const handler = jest.fn(async () => "user-result");
    const registered = (query as any)({
      args: {},
      returns: v.string(),
      handler,
    });
    await expect(registered.handler({}, {})).resolves.toBe("user-result");
  });

  it("redacts application exceptions before they reach native exception reporting", async () => {
    const registered = (mutation as any)({
      args: {},
      returns: v.null(),
      handler: async () => {
        throw new ConvexError({
          code: "EXPECTED",
          message: `Invalid value ${secret}`,
          nested: { serviceKey: secret },
        });
      },
    });
    try {
      await registered.handler({}, {});
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<any>).data.code).toBe("EXPECTED");
      expect(JSON.stringify((error as ConvexError<any>).data)).not.toContain(
        secret,
      );
    }
  });

  it("requires an explicit unexpired migration window for legacy workers", async () => {
    const registered = (mutation as any)({
      args: { serviceKey: v.string() },
      returns: v.null(),
      handler: async () => null,
    });
    process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL = String(Date.now() + 60_000);
    await expect(
      registered.handler(context("fixture:save"), { serviceKey: secret }),
    ).resolves.toBeNull();
    process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL = String(Date.now() - 1);
    await expect(
      registered.handler(context("fixture:save"), { serviceKey: secret }),
    ).rejects.toThrow("Invalid service request");
  });
});
