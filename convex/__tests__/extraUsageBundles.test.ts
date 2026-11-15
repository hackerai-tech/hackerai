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
import { getFunctionName } from "convex/server";

jest.mock("../lib/serviceFunctions", () => ({
  action: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("../lib/logger", () => ({
  convexLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../unitEconomicsLib", () => ({
  recordRevenueEventInternal: jest.fn(async () => ({
    alreadyRecorded: false,
  })),
}));

const mockMemberships = jest.fn<(...args: any[]) => any>();
const mockGetOrganization = jest.fn<(...args: any[]) => any>();
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    userManagement: { listOrganizationMemberships: mockMemberships },
    organizations: { getOrganization: mockGetOrganization },
  })),
}));

type AnyFn = (...args: any[]) => any;
const mockSessionCreate = jest.fn<AnyFn>();
const mockSessionRetrieve = jest.fn<AnyFn>();
const mockSessionList = jest.fn<AnyFn>();
const mockSessionExpire = jest.fn<AnyFn>();
const mockSubscriptionsList = jest.fn<AnyFn>();
jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockSessionCreate,
        retrieve: mockSessionRetrieve,
        list: mockSessionList,
        expire: mockSessionExpire,
      },
    },
    subscriptions: { list: mockSubscriptionsList },
  }));
  return {
    __esModule: true,
    default: Object.assign(Stripe, {
      errors: jest.requireActual("../../node_modules/stripe/cjs/Error.js"),
    }),
  };
});

const StripeErrors = jest.requireActual(
  "../../node_modules/stripe/cjs/Error.js",
) as any;

// ---------------------------------------------------------------------------
// In-memory indexed store. Index reads enforce declared field order, matching
// the Convex constraint that range filters follow the equality prefix. Rows
// are kept in insertion order, which stands in for _creationTime.
// ---------------------------------------------------------------------------

type Row = { _id: string; [key: string]: any };
const INDEXES: Record<string, Record<string, string[]>> = {
  extra_usage_bundle_reservations: {
    by_user_period_status_bundle: [
      "user_id",
      "period_month",
      "status",
      "bundle_id",
    ],
    by_user_attempt: ["user_id", "checkout_attempt_id"],
    by_stripe_checkout_session_id: ["stripe_checkout_session_id"],
  },
  extra_usage_bundle_attempts: {
    by_user_attempt: ["user_id", "checkout_attempt_id"],
  },
  extra_usage_purchases: {
    by_user_bundle_created_at: ["user_id", "bundle_id", "created_at"],
    by_stripe_checkout_session_id: ["stripe_checkout_session_id"],
  },
  extra_usage: { by_user_id: ["user_id"] },
  user_customization: { by_user_id: ["user_id"] },
  processed_checkout_sessions: { by_session_key: ["session_key"] },
  processed_webhooks: { by_event_id: ["event_id"] },
};

function createDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    extra_usage_bundle_reservations: [],
    extra_usage_bundle_attempts: [],
    extra_usage_purchases: [],
    extra_usage: [],
    user_customization: [],
    processed_checkout_sessions: [],
    processed_webhooks: [],
    ...seed,
  };
  let nextId = 0;
  const findRow = (id: string) =>
    Object.values(tables)
      .flat()
      .find((row) => row._id === id) ?? null;
  const resultsFor = (rows: () => Row[]) => ({
    take: async (n: number) => rows().slice(0, n),
    first: async () => rows()[0] ?? null,
    unique: async () => {
      const found = rows();
      if (found.length > 1) throw new Error("Expected unique row");
      return found[0] ?? null;
    },
  });
  const db = {
    query: (table: string) => ({
      withIndex: (name: string, build: (q: any) => any) => {
        const fields = INDEXES[table]?.[name];
        if (!fields) throw new Error(`Unknown index ${table}.${name}`);
        const predicates: Array<(row: Row) => boolean> = [];
        let position = 0;
        const expectField = (field: string) => {
          if (field !== fields[position])
            throw new Error(`Index ${name} out of order at ${field}`);
        };
        const q: any = {
          eq: (field: string, value: unknown) => {
            expectField(field);
            position++;
            predicates.push((row) => row[field] === value);
            return q;
          },
          gte: (field: string, value: number) => {
            expectField(field);
            predicates.push((row) => row[field] >= value);
            return q;
          },
          lt: (field: string, value: number) => {
            expectField(field);
            predicates.push((row) => row[field] < value);
            return q;
          },
        };
        build(q);
        const rows = () =>
          tables[table].filter((row) => predicates.every((p) => p(row)));
        return {
          ...resultsFor(rows),
          order: (direction: "asc" | "desc") =>
            resultsFor(() =>
              direction === "desc" ? [...rows()].reverse() : rows(),
            ),
        };
      },
    }),
    get: async (id: string) => findRow(id),
    normalizeId: (table: string, id: string) =>
      tables[table]?.some((row) => row._id === id) ? id : null,
    insert: async (table: string, doc: Record<string, unknown>) => {
      const _id = `${table}:${nextId++}`;
      tables[table].push({ _id, ...doc });
      return _id;
    },
    patch: async (id: string, patch: Record<string, unknown>) => {
      const row = findRow(id);
      if (!row) throw new Error(`Missing ${id}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
  };
  return { db, tables };
}

const USER = "user_cap";
const SERVICE_KEY = "service-key-fixture";
const NOV_15 = Date.UTC(2026, 10, 15, 12);
const HOUR = 60 * 60_000;
const ENV_KEYS = [
  "EXTRA_USAGE_BUNDLES_USER_IDS",
  "STRIPE_SECRET_KEY",
  "WORKOS_API_KEY",
  "CONVEX_SERVICE_ROLE_KEY",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let now = NOV_15;
let stripeSessions: Map<string, any>;
let sessionsByIdempotencyKey: Map<string, any>;

beforeAll(() => {
  process.env.EXTRA_USAGE_BUNDLES_USER_IDS = USER;
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  process.env.WORKOS_API_KEY = "workos_fixture";
  process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** A Stripe session whose create response was lost but which exists. */
function createLostSession(params: any, options: any) {
  const id = `cs_lost_${stripeSessions.size + 1}`;
  const session = {
    id,
    url: `https://checkout.stripe.test/${id}`,
    status: "open",
    payment_status: "unpaid",
    metadata: params.metadata,
  };
  stripeSessions.set(id, session);
  sessionsByIdempotencyKey.set(options.idempotencyKey, session);
  return session;
}

beforeEach(() => {
  jest.clearAllMocks();
  now = NOV_15;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  stripeSessions = new Map();
  sessionsByIdempotencyKey = new Map();
  mockMemberships.mockResolvedValue({
    data: [
      {
        organizationId: "org_personal",
        status: "active",
        role: { slug: "owner" },
      },
    ],
  });
  mockGetOrganization.mockResolvedValue({ stripeCustomerId: "cus_personal" });
  mockSubscriptionsList.mockResolvedValue({
    data: [{ items: { data: [{ price: { lookup_key: "pro-monthly" } }] } }],
  });
  // Model Stripe idempotency: a replayed key returns the original session.
  mockSessionCreate.mockImplementation(async (params: any, options: any) => {
    const existing = sessionsByIdempotencyKey.get(options?.idempotencyKey);
    if (existing) return existing;
    const id = `cs_fixture_${stripeSessions.size + 1}`;
    const session = {
      id,
      url: `https://checkout.stripe.test/${id}`,
      status: "open",
      payment_status: "unpaid",
      metadata: params.metadata,
    };
    stripeSessions.set(id, session);
    if (options?.idempotencyKey)
      sessionsByIdempotencyKey.set(options.idempotencyKey, session);
    return session;
  });
  mockSessionRetrieve.mockImplementation(async (id: any) => {
    const session = stripeSessions.get(id);
    if (!session)
      throw new StripeErrors.StripeInvalidRequestError({
        message: "No such checkout session",
      });
    return session;
  });
  mockSessionList.mockImplementation(async () => ({
    data: [...stripeSessions.values()],
    has_more: false,
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Action harness: runMutation executes the real mutation handlers against the
 * shared store one at a time, like Convex's serializable transactions.
 */
async function createHarness(seed: Record<string, Row[]> = {}) {
  const bundles = await import("../extraUsageBundles");
  const extraUsage = await import("../extraUsage");
  const actions = await import("../extraUsageActions");
  const { db, tables } = createDb(seed);
  const handlers: Record<string, any> = {
    "extraUsageBundles:reserveBundle": bundles.reserveBundle,
    "extraUsageBundles:attachBundleSession": bundles.attachBundleSession,
    "extraUsageBundles:releaseBundleHold": bundles.releaseBundleHold,
    "extraUsage:recordPurchaseCreated": extraUsage.recordPurchaseCreated,
  };
  let queue: Promise<unknown> = Promise.resolve();
  const runMutation = jest.fn((reference: any, args: any) => {
    const handler = handlers[getFunctionName(reference)];
    if (!handler) throw new Error(`Unexpected ${getFunctionName(reference)}`);
    const next = queue.then(() => handler.handler({ db }, args));
    queue = next.catch(() => undefined);
    return next;
  });
  const ctx = {
    auth: {
      getUserIdentity: async () => ({ subject: USER, org_id: "org_personal" }),
    },
    // The pending-holds query runs for real; the suspension lookup finds none.
    runQuery: jest.fn(async (reference: any, args: any) =>
      getFunctionName(reference) === "extraUsageBundles:listPendingBundleHolds"
        ? await (bundles.listPendingBundleHolds as any).handler({ db }, args)
        : null,
    ),
    runMutation,
  };
  /** The reconcile-only action the purchase dialog calls when it opens. */
  const reconcile = () =>
    (actions.reconcileBundleHolds as any).handler(ctx, {});
  const buy = (bundleId: string, checkoutAttemptId: string): Promise<any> => {
    const credit = { "usage-50-v1": 50, "usage-250-v1": 250 }[bundleId] ?? 1000;
    return (actions.createPurchaseSession as any).handler(ctx, {
      amountDollars: credit,
      bundleId,
      checkoutAttemptId,
      baseUrl: "https://hackerai.co",
      returnPath: "/settings",
    });
  };
  /** Stripe reports payment and the confirm route fulfills it. */
  const pay = async (purchase: { checkoutSessionId: string }) => {
    const session = stripeSessions.get(purchase.checkoutSessionId);
    session.status = "complete";
    session.payment_status = "paid";
    return await (extraUsage.addCredits as any).handler(
      { db },
      paidCredit(session.id, session.metadata),
    );
  };
  const status = () =>
    (bundles.getBundleCapStatus as any).handler({ db, auth: ctx.auth }, {});
  return {
    db,
    tables,
    ctx,
    buy,
    pay,
    status,
    reconcile,
    bundles,
    extraUsage,
    actions,
  };
}

function paidCredit(sessionId: string, metadata: Record<string, string>) {
  return {
    serviceKey: SERVICE_KEY,
    userId: USER,
    amountDollars: Number(metadata.amountDollars),
    paidAmountDollars: Number(metadata.paidAmountDollars),
    bundleId: metadata.bundleId,
    bundleReservationId: metadata.bundleReservationId,
    idempotencyKey: `cs_${sessionId}`,
    stripeCheckoutSessionId: sessionId,
    purchaseRoute: "confirm",
  };
}

const reservations = (tables: Record<string, Row[]>) =>
  tables.extra_usage_bundle_reservations;

describe("monthly discounted bundle cap", () => {
  it("recovers a paid attempt without allocating another checkout or granting credit twice", async () => {
    const { buy, pay, status, tables } = await createHarness();
    const first = await buy("usage-1000-v1", "attempt-paid");
    await pay(first);

    const retried = await buy("usage-1000-v1", "attempt-paid");
    expect(retried).toMatchObject({
      url: `https://hackerai.co/api/extra-usage/confirm?session_id=${first.checkoutSessionId}`,
      checkoutSessionId: first.checkoutSessionId,
      reservationReused: true,
    });
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect(reservations(tables)).toHaveLength(1);
    expect(await pay(first)).toMatchObject({ alreadyProcessed: true });
    expect((await status()).usedDollars).toBe(1000);
  });

  it("recovers a paid checkout whose success redirect and webhook have not fulfilled it", async () => {
    const { buy, tables } = await createHarness();
    const first = await buy("usage-1000-v1", "attempt-lost-redirect");
    const session = stripeSessions.get(first.checkoutSessionId);
    session.status = "complete";
    session.payment_status = "paid";

    const resumed = await buy("usage-1000-v1", "attempt-returned");
    expect(resumed.url).toBe(
      `https://hackerai.co/api/extra-usage/confirm?session_id=${first.checkoutSessionId}`,
    );
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect(reservations(tables)).toHaveLength(1);
  });

  it("allows two paid $1,000 bundles and blocks a third without calling Stripe", async () => {
    const { buy, pay, tables } = await createHarness();

    await pay(await buy("usage-1000-v1", "attempt-1"));
    // A completed purchase is never resumed; the next one gets its own hold.
    const second = await buy("usage-1000-v1", "attempt-2");
    expect(second.reservationReused).toBeUndefined();
    await pay(second);
    const third = await buy("usage-1000-v1", "attempt-3");

    expect(third).toMatchObject({
      url: null,
      errorCode: "bundle_cap_exceeded",
      bundleCap: { remainingDollars: 0, usedDollars: 2000 },
    });
    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    expect(reservations(tables).map((row) => row.status)).toEqual([
      "consumed",
      "consumed",
    ]);
  });

  it("combines offers and admits exactly the remaining face value", async () => {
    const { buy, pay, status } = await createHarness();
    for (const [index, bundleId] of [
      "usage-1000-v1",
      "usage-250-v1",
      "usage-250-v1",
      "usage-250-v1",
    ].entries()) {
      await pay(await buy(bundleId, `attempt-${index}`));
    }
    expect((await status()).remainingDollars).toBe(250);

    expect((await buy("usage-250-v1", "attempt-exact")).url).toBeTruthy();
    expect(await buy("usage-50-v1", "attempt-over")).toMatchObject({
      url: null,
      errorCode: "bundle_cap_exceeded",
    });
  });

  it("serializes competing offers so they cannot jointly exceed the cap", async () => {
    const { buy, pay, tables } = await createHarness();
    await pay(await buy("usage-1000-v1", "attempt-first"));

    // $1,000 and $250 each fit the remaining $1,000; together they do not.
    const results = await Promise.all([
      buy("usage-1000-v1", "attempt-a"),
      buy("usage-250-v1", "attempt-b"),
    ]);

    expect(results.filter((result) => result.url)).toHaveLength(1);
    expect(
      results.filter((result) => result.errorCode === "bundle_cap_exceeded"),
    ).toHaveLength(1);
    expect(
      reservations(tables).filter((row) => row.status === "reserved"),
    ).toHaveLength(1);
  });

  it("resumes the offer's pending checkout for a new attempt, keeping its original attempt ID", async () => {
    const { buy, tables } = await createHarness();
    const first = await buy("usage-1000-v1", "attempt-original");
    const resumed = await buy("usage-1000-v1", "attempt-after-reload");

    expect(resumed).toMatchObject({
      url: first.url,
      checkoutSessionId: first.checkoutSessionId,
      reservationReused: true,
      // The client adopts this, so start and success events share one ID.
      checkoutAttemptId: "attempt-original",
    });
    expect(first.checkoutAttemptId).toBe("attempt-original");
    expect(reservations(tables)).toHaveLength(1);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    expect(
      stripeSessions.get(first.checkoutSessionId).metadata.checkoutAttemptId,
    ).toBe("attempt-original");
    expect(await buy("usage-250-v1", "attempt-original")).toMatchObject({
      errorCode: "bundle_attempt_conflict",
    });
    // A resuming attempt is bound to its bundle too.
    expect(await buy("usage-250-v1", "attempt-after-reload")).toMatchObject({
      errorCode: "bundle_attempt_conflict",
    });
  });

  it("recovers the original paid checkout when a resuming attempt lost its response", async () => {
    const { buy, pay, tables } = await createHarness();
    const original = await buy("usage-1000-v1", "attempt-A");
    // B resumes A's checkout, but B's response never reaches the client.
    await buy("usage-1000-v1", "attempt-B");
    await pay(original);
    mockSessionCreate.mockClear();

    const retried = await buy("usage-1000-v1", "attempt-B");
    expect(retried).toMatchObject({
      url: `https://hackerai.co/api/extra-usage/confirm?session_id=${original.checkoutSessionId}`,
      checkoutSessionId: original.checkoutSessionId,
      checkoutAttemptId: "attempt-A",
    });

    // Still recovered after the UTC month rolls over.
    now = Date.UTC(2026, 11, 2);
    expect(await buy("usage-1000-v1", "attempt-B")).toMatchObject({
      checkoutSessionId: original.checkoutSessionId,
    });
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(reservations(tables)).toHaveLength(1);
    expect(tables.extra_usage_bundle_attempts).toHaveLength(2);
  });

  it("keeps a pending hold resumable at zero allowance, then restarts it once Stripe expires it", async () => {
    const { buy, pay, status, tables } = await createHarness();
    await pay(await buy("usage-1000-v1", "attempt-paid"));
    const pending = await buy("usage-1000-v1", "attempt-pending");

    expect(await status()).toMatchObject({
      remainingDollars: 0,
      resumableBundleIds: ["usage-1000-v1"],
    });
    // After a reload the client has a brand-new attempt ID.
    expect(await buy("usage-1000-v1", "attempt-new-client")).toMatchObject({
      url: pending.url,
      reservationReused: true,
    });

    stripeSessions.get(pending.checkoutSessionId).status = "expired";
    const restarted = await buy("usage-1000-v1", "attempt-after-expiry");

    expect(restarted.url).toBeTruthy();
    expect(restarted.checkoutSessionId).not.toBe(pending.checkoutSessionId);
    expect(
      reservations(tables).find(
        (row) => row.stripe_checkout_session_id === pending.checkoutSessionId,
      ),
    ).toMatchObject({
      status: "released",
      release_reason: "stripe_session_expired",
    });
    // The earlier attempt now follows the replacement, not the released hold.
    expect(await buy("usage-1000-v1", "attempt-new-client")).toMatchObject({
      checkoutSessionId: restarted.checkoutSessionId,
    });
    await pay(restarted);
    expect(await status()).toMatchObject({
      remainingDollars: 0,
      usedDollars: 2000,
      resumableBundleIds: [],
    });
  });

  it("frees an expired hold when the dialog opens without creating a checkout or granting credit", async () => {
    const { buy, pay, status, reconcile, tables } = await createHarness();
    await pay(await buy("usage-1000-v1", "attempt-paid"));
    const abandoned = await buy("usage-1000-v1", "attempt-abandoned");
    const balanceBefore = tables.extra_usage[0].balance_points;

    // An open checkout stays held.
    expect(await reconcile()).toEqual({ released: false });
    expect((await status()).remainingDollars).toBe(0);

    stripeSessions.get(abandoned.checkoutSessionId).status = "expired";
    mockSessionCreate.mockClear();
    expect(await reconcile()).toEqual({ released: true });

    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(tables.extra_usage[0].balance_points).toBe(balanceBefore);
    expect(await status()).toMatchObject({
      remainingDollars: 1000,
      usedDollars: 1000,
      resumableBundleIds: [],
    });
    expect((await buy("usage-250-v1", "attempt-smaller")).url).toBeTruthy();
  });

  it("resumes an ambiguous create with the same idempotency key and identical parameters", async () => {
    const { buy, tables } = await createHarness();
    mockSessionCreate.mockImplementationOnce(
      async (params: any, options: any) => {
        createLostSession(params, options);
        throw new StripeErrors.StripeConnectionError({
          message: "socket hang up",
        });
      },
    );

    expect(await buy("usage-1000-v1", "attempt-ambiguous")).toMatchObject({
      url: null,
      errorCode: "bundle_checkout_pending",
      retryable: true,
    });
    expect(reservations(tables)[0].status).toBe("reserved");

    const resumed = await buy("usage-1000-v1", "attempt-new-client");
    expect(resumed.checkoutSessionId).toMatch(/^cs_lost_/);
    expect(reservations(tables)).toHaveLength(1);
    const [firstCall, secondCall] = mockSessionCreate.mock.calls as any[];
    expect(secondCall[1].idempotencyKey).toBe(firstCall[1].idempotencyKey);
    expect(secondCall[0]).toEqual(firstCall[0]);
  });

  it("releases a fresh hold when Stripe rejects its first create call", async () => {
    const { buy, tables, status } = await createHarness();
    mockSessionCreate.mockRejectedValueOnce(
      new StripeErrors.StripeInvalidRequestError({
        message: "Invalid customer",
      }),
    );

    expect(await buy("usage-1000-v1", "attempt-rejected")).toMatchObject({
      errorCode: "bundle_checkout_failed",
      retryable: true,
    });
    expect(reservations(tables)[0]).toMatchObject({
      status: "released",
      release_reason: "stripe_create_rejected",
    });
    expect((await status()).remainingDollars).toBe(2000);
    expect((await buy("usage-1000-v1", "attempt-rejected")).url).toBeTruthy();
    expect(reservations(tables)).toHaveLength(2);
  });

  it.each([
    ["invalid request", StripeErrors.StripeInvalidRequestError],
    ["authentication", StripeErrors.StripeAuthenticationError],
    ["permission", StripeErrors.StripePermissionError],
  ])(
    "keeps a retried ambiguous hold after a %s error",
    async (_label, ErrorType) => {
      const { buy, tables } = await createHarness();
      mockSessionCreate.mockImplementationOnce(
        async (params: any, options: any) => {
          createLostSession(params, options);
          throw new StripeErrors.StripeAPIError({ message: "upstream 500" });
        },
      );
      await buy("usage-1000-v1", "attempt-1");
      mockSessionCreate.mockRejectedValueOnce(
        new ErrorType({ message: "rejected replay" }),
      );

      expect(await buy("usage-1000-v1", "attempt-2")).toMatchObject({
        errorCode: "bundle_checkout_pending",
        retryable: true,
      });
      expect(reservations(tables)).toHaveLength(1);
      expect(reservations(tables)[0]).toMatchObject({
        status: "reserved",
        create_attempts: 2,
      });
    },
  );

  it("never releases an unlinked hold because a Stripe search finds nothing", async () => {
    const { buy, pay, tables } = await createHarness();
    const { convexLogger } = await import("../lib/logger");
    await pay(await buy("usage-1000-v1", "attempt-paid"));
    mockSessionCreate.mockRejectedValueOnce(
      new StripeErrors.StripeAPIError({ message: "upstream timeout" }),
    );
    await buy("usage-1000-v1", "attempt-unknown");
    const unknown = reservations(tables).find(
      (row) => row.checkout_attempt_id === "attempt-unknown",
    )!;

    // A young hold may still have a create call in flight: not searched.
    expect(await buy("usage-50-v1", "attempt-young")).toMatchObject({
      errorCode: "bundle_cap_exceeded",
    });
    expect(mockSessionList).not.toHaveBeenCalled();

    now += 6 * 60_000;
    expect(await buy("usage-50-v1", "attempt-later")).toMatchObject({
      errorCode: "bundle_cap_exceeded",
    });
    expect(mockSessionList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_personal" }),
    );
    expect(unknown.status).toBe("reserved");
    expect(convexLogger.error).toHaveBeenCalledWith(
      "extra_usage_bundle_hold_unresolved",
      expect.objectContaining({
        reservation_id: unknown._id,
        reason: "session_not_found",
      }),
    );
  });

  it("discovers a lost session and releases its hold only after Stripe expires it", async () => {
    const { buy, pay, tables } = await createHarness();
    await pay(await buy("usage-1000-v1", "attempt-paid"));
    mockSessionCreate.mockImplementationOnce(
      async (params: any, options: any) => {
        createLostSession(params, options);
        throw new StripeErrors.StripeConnectionError({ message: "reset" });
      },
    );
    await buy("usage-1000-v1", "attempt-lost");
    const lost = reservations(tables).find(
      (row) => row.checkout_attempt_id === "attempt-lost",
    )!;
    now += 6 * 60_000;

    // Found and linked, but still open: the hold stays.
    expect((await buy("usage-50-v1", "attempt-1")).errorCode).toBe(
      "bundle_cap_exceeded",
    );
    expect(lost).toMatchObject({ status: "reserved" });
    expect(lost.stripe_checkout_session_id).toMatch(/^cs_lost_/);

    stripeSessions.get(lost.stripe_checkout_session_id).status = "expired";
    expect((await buy("usage-50-v1", "attempt-2")).url).toBeTruthy();
    expect(lost).toMatchObject({
      status: "released",
      release_reason: "stripe_session_expired",
    });
  });

  it("does not replay an unlinked hold's idempotency key after 23 hours", async () => {
    const { buy, tables } = await createHarness();
    mockSessionCreate.mockImplementationOnce(
      async (params: any, options: any) => {
        createLostSession(params, options);
        throw new StripeErrors.StripeConnectionError({ message: "reset" });
      },
    );
    await buy("usage-1000-v1", "attempt-old");
    const hold = reservations(tables)[0];
    const createdAt = hold.created_at;
    now += 23 * HOUR + 60_000;
    // Stripe's listing has not caught up with the lost session.
    mockSessionList.mockResolvedValueOnce({ data: [], has_more: false });
    mockSessionCreate.mockClear();

    expect(await buy("usage-1000-v1", "attempt-next-day")).toMatchObject({
      url: null,
      errorCode: "bundle_checkout_unresolved",
      retryable: false,
    });
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(hold).toMatchObject({ status: "reserved", created_at: createdAt });

    // Once found, the original session is resumed rather than duplicated.
    const resumed = await buy("usage-1000-v1", "attempt-next-day");
    expect(resumed.checkoutSessionId).toMatch(/^cs_lost_/);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(reservations(tables)).toHaveLength(1);
  });

  it("collapses concurrent retries of an unlinked hold onto one Stripe session", async () => {
    const { buy, tables } = await createHarness();
    mockSessionCreate.mockRejectedValueOnce(
      new StripeErrors.StripeAPIError({ message: "upstream timeout" }),
    );
    await buy("usage-1000-v1", "attempt-1");

    const retries = await Promise.all([
      buy("usage-1000-v1", "attempt-2"),
      buy("usage-1000-v1", "attempt-3"),
    ]);

    expect(new Set(retries.map((r) => r.checkoutSessionId)).size).toBe(1);
    expect(stripeSessions.size).toBe(1);
    expect(reservations(tables)).toHaveLength(1);
    const keys = new Set(
      (mockSessionCreate.mock.calls as any[]).map(
        ([, options]) => options.idempotencyKey,
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("finds an attempt's pending hold behind more than 20 released retries", async () => {
    const october = Date.UTC(2026, 9, 31, 23);
    const reservation = (index: number, status: string): Row => ({
      _id: `reservation:seed-${index}`,
      user_id: USER,
      period_month: "2026-10",
      policy_version: "bundle-cap-v1",
      checkout_attempt_id: "attempt-long-lived",
      bundle_id: "usage-250-v1",
      credit_dollars: 250,
      paid_dollars: 200,
      status,
      stripe_customer_id: "cus_personal",
      application_origin: "https://hackerai.co",
      create_attempts: 1,
      created_at: october,
      updated_at: october,
      ...(status === "reserved" && {
        stripe_checkout_session_id: "cs_october_open",
      }),
      ...(status === "released" && {
        release_reason: "stripe_session_expired",
      }),
    });
    const { buy, tables } = await createHarness({
      extra_usage_bundle_reservations: [
        ...Array.from({ length: 25 }, (_, i) => reservation(i, "released")),
        reservation(25, "reserved"),
      ],
    });
    stripeSessions.set("cs_october_open", {
      id: "cs_october_open",
      url: "https://checkout.stripe.test/cs_october_open",
      status: "open",
      payment_status: "unpaid",
    });

    expect(await buy("usage-250-v1", "attempt-long-lived")).toMatchObject({
      checkoutSessionId: "cs_october_open",
      reservationReused: true,
    });
    expect(reservations(tables)).toHaveLength(26);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("keeps full-price custom top-ups outside the bundle cap", async () => {
    const { buy, pay, ctx, actions, tables } = await createHarness();
    await pay(await buy("usage-1000-v1", "attempt-1"));
    await pay(await buy("usage-1000-v1", "attempt-2"));

    const custom = await (actions.createPurchaseSession as any).handler(ctx, {
      amountDollars: 5000,
      baseUrl: "https://hackerai.co",
      checkoutAttemptId: "attempt-custom",
    });

    expect(custom.url).toBeTruthy();
    expect(custom.bundleCap).toBeUndefined();
    expect(reservations(tables)).toHaveLength(2);
  });
});

describe("historical and fulfilled bundle allowance", () => {
  let ledgerId = 0;
  const ledgerRow = (overrides: Partial<Row>): Row => ({
    _id: `purchase:${++ledgerId}`,
    user_id: USER,
    amount_dollars: 1000,
    stripe_checkout_session_id: `cs_hist_${ledgerId}`,
    status: "credited",
    created_at: Date.UTC(2026, 10, 3),
    updated_at: Date.UTC(2026, 10, 3),
    ...overrides,
  });

  it("counts current-month pre-cap bundle purchases once and ignores top-ups and other months", async () => {
    const claimedSession = "cs_claimed";
    const { status, buy } = await createHarness({
      extra_usage_purchases: [
        ledgerRow({ bundle_id: "usage-1000-v1", amount_dollars: 1000 }),
        // Paid in this month's window but credit is still pending.
        ledgerRow({
          bundle_id: "usage-250-v1",
          amount_dollars: 250,
          status: "paid_seen",
        }),
        // A pre-cap checkout that could still be paid holds allowance.
        ledgerRow({
          bundle_id: "usage-50-v1",
          amount_dollars: 50,
          status: "created",
          stripe_checkout_session_id: "cs_legacy_open",
        }),
        ledgerRow({
          bundle_id: "usage-250-v1",
          amount_dollars: 250,
          status: "failed",
          last_error: "stripe_async_payment_failed",
        }),
        // Stripe canceled its payment: never paid, so it frees allowance.
        ledgerRow({
          bundle_id: "usage-1000-v1",
          amount_dollars: 1000,
          status: "failed",
          last_error: "stripe_payment_canceled",
        }),
        // Paid, but crediting failed: it still consumes allowance.
        ledgerRow({
          bundle_id: "usage-250-v1",
          amount_dollars: 250,
          status: "failed",
          last_error: "Convex unavailable",
        }),
        ledgerRow({ amount_dollars: 5000 }),
        ledgerRow({
          bundle_id: "usage-1000-v1",
          created_at: Date.UTC(2026, 9, 31, 23, 59),
        }),
        ledgerRow({
          bundle_id: "usage-250-v1",
          amount_dollars: 250,
          stripe_checkout_session_id: claimedSession,
        }),
      ],
      extra_usage_bundle_reservations: [
        {
          _id: "reservation:claimed",
          user_id: USER,
          period_month: "2026-11",
          policy_version: "bundle-cap-v1",
          checkout_attempt_id: "attempt-claimed",
          bundle_id: "usage-250-v1",
          credit_dollars: 250,
          paid_dollars: 200,
          status: "consumed",
          stripe_customer_id: "cus_personal",
          stripe_checkout_session_id: claimedSession,
          application_origin: "https://hackerai.co",
          create_attempts: 1,
          created_at: Date.UTC(2026, 10, 4),
          updated_at: Date.UTC(2026, 10, 4),
        },
      ],
    });

    expect(await status()).toMatchObject({
      periodMonth: "2026-11",
      usedDollars: 1750,
      pendingDollars: 50,
      remainingDollars: 200,
      historyComplete: true,
      resumableBundleIds: ["usage-50-v1"],
    });

    // The pre-cap open checkout is resumed instead of taking a second hold,
    // and keeps the attempt ID recorded in its Stripe metadata.
    stripeSessions.set("cs_legacy_open", {
      id: "cs_legacy_open",
      url: "https://checkout.stripe.test/cs_legacy_open",
      status: "open",
      payment_status: "unpaid",
      metadata: { checkoutAttemptId: "attempt-pre-cap" },
    });
    expect(await buy("usage-50-v1", "attempt-legacy")).toMatchObject({
      checkoutSessionId: "cs_legacy_open",
      reservationReused: true,
      checkoutAttemptId: "attempt-pre-cap",
    });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("fails closed with a reconciliation log when history exceeds the read bound", async () => {
    const { BUNDLE_CAP_READ_LIMIT } =
      await import("../lib/extraUsageBundleCap");
    const { convexLogger } = await import("../lib/logger");
    const { buy, status } = await createHarness({
      extra_usage_purchases: Array.from({ length: BUNDLE_CAP_READ_LIMIT }, () =>
        ledgerRow({
          bundle_id: "usage-50-v1",
          amount_dollars: 50,
          status: "failed",
          last_error: "stripe_session_expired",
        }),
      ),
    });

    expect(await status()).toMatchObject({
      historyComplete: false,
      remainingDollars: 0,
    });
    expect(await buy("usage-50-v1", "attempt-incomplete")).toMatchObject({
      url: null,
      errorCode: "bundle_cap_unavailable",
    });
    expect(convexLogger.error).toHaveBeenCalledWith(
      "extra_usage_bundle_cap_history_incomplete",
      expect.objectContaining({ user_id: USER, period_month: "2026-11" }),
    );
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("keeps a late-paid checkout in its creation month across the UTC rollover", async () => {
    now = Date.UTC(2026, 10, 30, 23, 59, 59, 999);
    const { buy, pay, status, tables } = await createHarness();
    const late = await buy("usage-1000-v1", "attempt-1");
    expect(late.bundleCap.periodMonth).toBe("2026-11");

    now = Date.UTC(2026, 11, 1);
    expect(await status()).toMatchObject({
      periodMonth: "2026-12",
      remainingDollars: 2000,
      resumableBundleIds: [],
    });
    expect(
      stripeSessions.get(late.checkoutSessionId).metadata.bundleCapPeriod,
    ).toBe("2026-11");

    await pay(late);
    expect(reservations(tables)[0]).toMatchObject({
      status: "consumed",
      period_month: "2026-11",
    });
    expect((await status()).remainingDollars).toBe(2000);
  });

  it("credits a paid session once even after its hold was released", async () => {
    const { buy, tables, extraUsage, db } = await createHarness();
    const first = await buy("usage-1000-v1", "attempt-1");
    reservations(tables)[0].status = "released";
    reservations(tables)[0].release_reason = "stripe_session_expired";
    const metadata = stripeSessions.get(first.checkoutSessionId).metadata;

    const credited = await (extraUsage.addCredits as any).handler(
      { db },
      paidCredit(first.checkoutSessionId, metadata),
    );
    const duplicate = await (extraUsage.addCredits as any).handler(
      { db },
      {
        ...paidCredit(first.checkoutSessionId, metadata),
        purchaseRoute: "webhook",
      },
    );

    expect(credited.alreadyProcessed).toBe(false);
    expect(duplicate.alreadyProcessed).toBe(true);
    expect(tables.extra_usage[0].balance_points).toBeGreaterThan(0);
    expect(reservations(tables)[0]).toMatchObject({
      status: "consumed",
      consumed_after_release: true,
    });
  });

  it("releases a hold only for the session Stripe reported as expired", async () => {
    const { buy, tables, bundles, db } = await createHarness();
    const held = await buy("usage-1000-v1", "attempt-1");
    const release = (stripeCheckoutSessionId: string, userId = USER) =>
      (bundles.releaseBundleSessionFromStripe as any).handler(
        { db },
        {
          serviceKey: SERVICE_KEY,
          userId,
          stripeCheckoutSessionId,
          reason: "stripe_session_expired",
        },
      );

    expect(await release(held.checkoutSessionId, "user_other")).toEqual({
      released: false,
    });
    expect(await release(held.checkoutSessionId)).toEqual({ released: true });
    expect(reservations(tables)[0].status).toBe("released");
  });
});
