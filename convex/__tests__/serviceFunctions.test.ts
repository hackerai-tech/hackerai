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
  internalQuery,
  internalMutation,
  internalAction,
  serviceContext,
} from "../lib/serviceFunctions";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const secret = "synthetic-main-service-credential";
const researchSecret = "synthetic-research-credential";
const egressReviewSecret = "synthetic-egress-review-credential";
const deployment = "https://fixture.convex.cloud";
const original = { ...process.env };
beforeEach(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = secret;
  process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = researchSecret;
  process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY = egressReviewSecret;
  process.env.CONVEX_CLOUD_URL = deployment;
  delete process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL;
});
afterAll(() => {
  process.env = original;
});

const context = (name: string, type = "mutation", componentPath = "") => ({
  meta: {
    getFunctionMetadata: async () => ({ name, type, componentPath }),
  },
});

// The guard's exact rejection: an unchanged first line and one fixed
// observation line, which native exception reporting retains without logs.
const rejectedMessage = (observation: string) =>
  "Unauthorized: Invalid service request\n" +
  `service_proof_rejected diagnostic_version=1 public_input_observation=${observation}`;
const unauthorized = new RegExp(
  `^${rejectedMessage(
    "(credential_not_string|proof_malformed|proof_expired|proof_future|verification_failed)",
  )}$`,
);
const messageOf = (pending: Promise<unknown>) =>
  pending.then(
    () => "accepted",
    (error: Error) => error.message,
  );
let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// Every warning line, minus the logger's own timestamp, so tests compare the
// complete emitted payload and catch any added field.
const warnings = () =>
  warn.mock.calls.map(([line]) => {
    const { timestamp, ...rest } = JSON.parse(line as string);
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    return rest;
  });
const rejection = (observation: string) => ({
  level: "warn",
  event: "service_proof_rejected",
  diagnostic_version: 1,
  public_input_observation: observation,
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
    // The main key does not authorize research functions either.
    const mainProof = await signServiceArgs(
      { deployment, name: researchName, type: "mutation" },
      { serviceKey: secret },
    );
    await expect(
      registered.handler(context(researchName), mainProof),
    ).rejects.toThrow(unauthorized);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([
      rejection("verification_failed"),
      rejection("verification_failed"),
    ]);
  });

  it("isolates the burst review key from account enforcement and the general service key", async () => {
    const registered = (mutation as any)({
      args: { serviceKey: v.string() },
      returns: v.null(),
      handler: async () => null,
    });
    const invoke = async (name: string, serviceKey: string) => {
      const signed = await signServiceArgs(
        { deployment, name, type: "mutation" },
        { serviceKey },
      );
      return registered.handler(context(name), signed);
    };
    const review = "egressAbuseReview:recordCase";
    await expect(invoke(review, egressReviewSecret)).resolves.toBeNull();
    await expect(invoke(review, secret)).rejects.toThrow(unauthorized);
    await expect(
      invoke("abuseResponse:apply", egressReviewSecret),
    ).rejects.toThrow(unauthorized);
    delete process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY;
    await expect(invoke(review, egressReviewSecret)).rejects.toThrow(
      unauthorized,
    );
  });

  it("extends the burst review key to exactly one reassessment action", async () => {
    const registered = (action as any)({
      args: { serviceKey: v.string() },
      returns: v.null(),
      handler: async () => null,
    });
    const invoke = async (name: string, serviceKey: string) => {
      const signed = await signServiceArgs(
        { deployment, name, type: "action" },
        { serviceKey },
      );
      return registered.handler(context(name, "action"), signed);
    };
    const reassess = "egressAbuseReassessmentActions:readCaseEvidence";
    await expect(invoke(reassess, egressReviewSecret)).resolves.toBeNull();
    await expect(invoke(reassess, secret)).rejects.toThrow(unauthorized);
    for (const name of [
      "egressAbuseReassessmentActions:other",
      "egressAbuseReassessment:openCase",
      "abuseCases:read",
    ])
      await expect(invoke(name, egressReviewSecret)).rejects.toThrow(
        unauthorized,
      );
  });

  it("limits the enforcement and notice dispatcher keys to their own modules", async () => {
    const enforcementSecret = "synthetic-enforcement-credential";
    const dispatchSecret = "synthetic-dispatch-credential";
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY = enforcementSecret;
    process.env.CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY = dispatchSecret;
    const registered = (mutation as any)({
      args: { serviceKey: v.string() },
      returns: v.null(),
      handler: async () => null,
    });
    const invoke = async (name: string, serviceKey: string) => {
      const signed = await signServiceArgs(
        { deployment, name, type: "mutation" },
        { serviceKey },
      );
      return registered.handler(context(name), signed);
    };
    const block = "egressAbuseEnforcement:applyBlock";
    const claim = "abuseBlockNotices:claim";
    await expect(invoke(block, enforcementSecret)).resolves.toBeNull();
    await expect(invoke(claim, dispatchSecret)).resolves.toBeNull();
    for (const [name, wrong] of [
      [block, egressReviewSecret],
      [block, dispatchSecret],
      [block, secret],
      [claim, enforcementSecret],
      [claim, secret],
      ["abuseResponse:apply", enforcementSecret],
      ["abuseCases:resolve", dispatchSecret],
      ["egressAbuseReview:recordCase", enforcementSecret],
    ])
      await expect(invoke(name, wrong)).rejects.toThrow(unauthorized);
    // A proof for one deployment is refused by another.
    const elsewhere = await signServiceArgs(
      {
        deployment: "https://other.convex.cloud",
        name: claim,
        type: "mutation",
      },
      { serviceKey: dispatchSecret },
    );
    await expect(registered.handler(context(claim), elsewhere)).rejects.toThrow(
      unauthorized,
    );
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

describe("service proof rejection observation", () => {
  const name = "fixture:save";
  const scope = { deployment, name, type: "mutation" as const };
  const register = (builder: unknown = mutation) => {
    const handler = jest.fn(async () => null);
    const args = { serviceKey: v.any(), id: v.optional(v.string()) };
    const returns = v.null();
    const registered = (builder as any)({ args, returns, handler });
    return { registered, handler, args, returns };
  };
  const proofAt = async (issuedAt: number) =>
    (await signServiceArgs(scope, { serviceKey: secret, id: "id-1" }, issuedAt))
      .serviceKey;

  it.each([
    ["query", query, "query"],
    ["mutation", mutation, "mutation"],
    ["action", action, "action"],
    ["internalQuery", internalQuery, "query"],
    ["internalMutation", internalMutation, "mutation"],
    ["internalAction", internalAction, "action"],
  ] as const)(
    "%s keeps its validators and warns once at the rejected guard",
    async (_label, builder, type) => {
      const { registered, handler, args, returns } = register(builder);
      expect(registered.args).toBe(args);
      expect(registered.returns).toBe(returns);
      await expect(
        messageOf(
          registered.handler(context(name, type), { serviceKey: "hmac1.bad" }),
        ),
      ).resolves.toBe(rejectedMessage("proof_malformed"));
      expect(handler).not.toHaveBeenCalled();
      expect(warnings()).toEqual([rejection("proof_malformed")]);
    },
  );

  it("rejects with the same observation whatever the key, scope or arguments", async () => {
    const { registered, handler } = register();
    const issued = Date.now();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ serviceKey: 17 }, "credential_not_string"],
      [{ serviceKey: null }, "credential_not_string"],
      [{ serviceKey: "garbage" }, "proof_malformed"],
      [{ serviceKey: await proofAt(issued - 120_000) }, "proof_expired"],
      [{ serviceKey: await proofAt(issued + 120_000) }, "proof_future"],
      [
        { serviceKey: `hmac1.${issued}.${"0".repeat(64)}`, id: "id-1" },
        "verification_failed",
      ],
    ];
    // The signed scope, another function with its own key, and another type.
    const scopes = [
      [name, "mutation"],
      ["userResearch:createAnalysis", "mutation"],
      [name, "query"],
    ] as const;
    for (const [base, expected] of cases) {
      for (const args of [base, { ...base, id: "other-argument" }]) {
        for (const [scopeName, type] of scopes) {
          for (const configured of [true, false]) {
            if (configured) {
              process.env.CONVEX_SERVICE_ROLE_KEY = secret;
              process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = researchSecret;
            } else {
              delete process.env.CONVEX_SERVICE_ROLE_KEY;
              delete process.env.CONVEX_USER_RESEARCH_SERVICE_KEY;
            }
            warn.mockClear();
            const error = await messageOf(
              registered.handler(context(scopeName, type), args),
            );
            expect({ scopeName, type, configured, args, error }).toEqual({
              scopeName,
              type,
              configured,
              args,
              error: rejectedMessage(expected),
            });
            expect(warnings()).toEqual([rejection(expected)]);
          }
        }
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not reveal whether a raw key is correct once the legacy window is closed", async () => {
    const { registered, handler } = register();
    const outcomes: unknown[] = [];
    for (const window of [String(Date.now() - 1), undefined]) {
      for (const configured of [true, false]) {
        for (const serviceKey of [secret, "x".repeat(secret.length), "guess"]) {
          if (window === undefined)
            delete process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL;
          else process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL = window;
          if (configured) process.env.CONVEX_SERVICE_ROLE_KEY = secret;
          else delete process.env.CONVEX_SERVICE_ROLE_KEY;
          warn.mockClear();
          const error = await registered
            .handler(context(name), { serviceKey })
            .then(
              () => "accepted",
              (e: Error) => e.message,
            );
          outcomes.push({ error, warnings: warnings() });
        }
      }
    }
    expect(outcomes).toHaveLength(12);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        error: rejectedMessage("proof_malformed"),
        warnings: [rejection("proof_malformed")],
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not warn for accepted, ordinary or pre-guard paths", async () => {
    const { registered, handler } = register();
    const signed = await signServiceArgs(scope, {
      serviceKey: secret,
      id: "id-1",
    });
    await expect(registered.handler(context(name), signed)).resolves.toBeNull();
    process.env.CONVEX_SERVICE_AUTH_LEGACY_UNTIL = String(Date.now() + 60_000);
    await expect(
      registered.handler(context(name), { serviceKey: secret }),
    ).resolves.toBeNull();
    await expect(registered.handler({}, { id: "id-1" })).resolves.toBeNull();
    expect(handler.mock.calls).toEqual([
      [expect.anything(), { serviceKey: secret, id: "id-1" }],
      [expect.anything(), { serviceKey: secret }],
      [expect.anything(), { id: "id-1" }],
    ]);
    await expect(
      registered.handler(context(name, "mutation", "child"), {
        serviceKey: "garbage",
      }),
    ).rejects.toThrow(/^Invalid service deployment identity$/);
    delete process.env.CONVEX_CLOUD_URL;
    await expect(
      registered.handler(context(name), { serviceKey: "garbage" }),
    ).rejects.toThrow(/^Invalid service deployment identity$/);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["importKey", "verify"] as const)(
    "propagates the exact %s exception without a rejection warning",
    async (method) => {
      const { registered, handler } = register();
      const signed = await signServiceArgs(scope, {
        serviceKey: secret,
        id: "id-1",
      });
      const failure = new Error(`${method} failed`);
      jest.spyOn(crypto.subtle, method).mockRejectedValueOnce(failure);
      await expect(registered.handler(context(name), signed)).rejects.toBe(
        failure,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("keeps the authorization failure when the log sink throws", async () => {
    const { registered, handler } = register();
    warn.mockImplementation(() => {
      throw new Error(`sink failed ${secret}`);
    });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      messageOf(registered.handler(context(name), { serviceKey: "garbage" })),
    ).resolves.toBe(rejectedMessage("proof_malformed"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs and throws no proof, key, scope or argument values", async () => {
    const { registered } = register();
    const issued = Date.now();
    const forged = `hmac1.${issued}.${"c".repeat(64)}`;
    const error = await messageOf(
      registered.handler(context(name), {
        serviceKey: forged,
        id: "canary-argument-value",
      }),
    );
    expect(error).toBe(rejectedMessage("verification_failed"));
    const logged = JSON.stringify([warn.mock.calls, error]);
    for (const canary of [
      secret,
      researchSecret,
      forged,
      "c".repeat(64),
      String(issued),
      deployment,
      name,
      "canary-argument-value",
    ]) {
      expect(logged).not.toContain(canary);
    }
    expect(warnings()).toEqual([rejection("verification_failed")]);
  });
});
