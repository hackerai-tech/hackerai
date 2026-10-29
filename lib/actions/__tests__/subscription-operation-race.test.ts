import { getFunctionName } from "convex/server";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import { withSubscriptionOperation } from "@/lib/billing/subscription-operation";
import * as operations from "@/convex/billingOperations";
import cancel from "../cancel-subscription";
import keep from "../keep-subscription";

jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (x: unknown) => x,
}));
jest.mock("@/convex/lib/utils", () => ({ validateServiceKey: jest.fn() }));
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
const mockList = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/app/api/stripe", () => ({
  stripe: {
    subscriptions: {
      list: (...args: unknown[]) => mockList(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));
jest.mock("@/lib/actions/billing-context", () => ({
  getBillingActionContext: async () => ({
    user: { id: "user_test" },
    organizationId: "org_test",
    stripeCustomerId: "cus_test",
  }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const reason = {
  cancellationReason: {
    reasonCategory: "other",
    reasonSubcategory: "other",
    reasonDetails: "Synthetic race test",
  },
} as const;
let subscription: any;
let rows: any[];
let transaction: Promise<unknown>;
let ctx: any;
const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONVEX_SERVICE_ROLE_KEY = "test";
  rows = [];
  let id = 0;
  transaction = Promise.resolve();
  // Convex serializes mutation transactions. Run the real mutation handlers
  // against this small DB fake; the lock is not mocked as always-acquired.
  ctx = {
    db: {
      query: () => ({
        withIndex: (_: string, builder: any) => {
          let customer: string;
          builder({
            eq: (_: string, value: string) => {
              customer = value;
            },
          });
          return {
            unique: async () =>
              rows.find((r) => r.stripe_customer_id === customer) ?? null,
          };
        },
      }),
      insert: async (_: string, value: any) => {
        rows.push({ ...value, _id: String(++id) });
      },
      patch: async (key: string, value: any) => {
        Object.assign(
          rows.find((r) => r._id === key),
          value,
        );
      },
      delete: async (key: string) => {
        rows = rows.filter((r) => r._id !== key);
      },
    },
  };
  mockMutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref);
    if (!name.startsWith("billingOperations:")) {
      return Promise.resolve(
        name.endsWith("recordCancellationStarted")
          ? "reason_test"
          : { updatedCount: 1, canceledCount: 0 },
      );
    }
    const fn = name.split(":")[1] as keyof typeof operations;
    const result = transaction.then(() =>
      (operations[fn] as any).handler(ctx, args),
    );
    transaction = result.catch(() => {});
    return result;
  });
  subscription = {
    id: "sub_test",
    status: "active",
    cancel_at_period_end: false,
    metadata: {},
    items: {
      data: [
        {
          price: { id: "price_test", lookup_key: "pro-monthly-plan" },
          quantity: 1,
        },
      ],
    },
  };
  mockList.mockImplementation(() => {
    const snapshot = JSON.parse(JSON.stringify(subscription));
    return Object.assign(Promise.resolve({ data: [snapshot] }), {
      async *[Symbol.asyncIterator]() {
        yield snapshot;
      },
    });
  });
  mockUpdate.mockImplementation(async (_id, params) => {
    Object.assign(subscription, params);
    return JSON.parse(JSON.stringify(subscription));
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
});

it.each(["cancel", "keep"] as const)(
  "rejects an overlapping command while %s is in flight, then retries from fresh Stripe state",
  async (first) => {
    subscription.cancel_at_period_end = first === "keep";
    const started = deferred();
    const resume = deferred();
    mockUpdate.mockImplementationOnce(async (_id, params) => {
      started.resolve();
      await resume.promise;
      Object.assign(subscription, params);
      return JSON.parse(JSON.stringify(subscription));
    });
    const runFirst = first === "cancel" ? () => cancel(reason) : () => keep();
    const runSecond = first === "cancel" ? () => keep() : () => cancel(reason);
    const pending = runFirst();
    await started.promise;
    await expect(runSecond()).rejects.toThrow(
      BILLING_ERRORS.subscriptionChangeInProgress,
    );
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    resume.resolve();
    await pending;
    await runSecond();
    expect(subscription.cancel_at_period_end).toBe(first === "keep");
    expect(rows).toHaveLength(0);
  },
);

it("holds the fence before the initial read so keep cannot report already-kept during a cancel", async () => {
  const reading = deferred();
  const resume = deferred<any>();
  mockList.mockImplementationOnce(() => {
    reading.resolve();
    return resume.promise;
  });
  const pending = cancel(reason);
  await reading.promise;
  await expect(keep()).rejects.toThrow(
    BILLING_ERRORS.subscriptionChangeInProgress,
  );
  resume.resolve({ data: [JSON.parse(JSON.stringify(subscription))] });
  await pending;
  await keep();
  expect(subscription.cancel_at_period_end).toBe(false);
});

it("keeps an unknown Stripe outcome fenced even after time passes and Stripe applies late", async () => {
  mockUpdate.mockRejectedValueOnce(
    Object.assign(new Error("connection lost"), {
      type: "StripeConnectionError",
    }),
  );
  await expect(cancel(reason)).rejects.toThrow("connection lost");
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
  subscription.cancel_at_period_end = true; // provider applies after client timeout
  await expect(keep()).rejects.toThrow(
    BILLING_ERRORS.subscriptionChangeInProgress,
  );
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(rows[0].writing).toBe(true);
});

it("allows a fresh command after a definitive Stripe rejection", async () => {
  mockUpdate.mockRejectedValueOnce(
    Object.assign(new Error("invalid request"), {
      type: "StripeInvalidRequestError",
      statusCode: 400,
    }),
  );
  await expect(cancel(reason)).rejects.toThrow("invalid request");
  expect(rows).toHaveLength(0);
  await cancel(reason);
  expect(subscription.cancel_at_period_end).toBe(true);
});

it("does not start Stripe work if coordination is unavailable", async () => {
  mockMutation.mockRejectedValueOnce(new Error("offline"));
  await expect(cancel(reason)).rejects.toThrow(
    BILLING_ERRORS.subscriptionChangeUnavailable,
  );
  expect(mockList).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("fences an expired preflight owner and prevents it from deleting its successor", async () => {
  const started = deferred();
  const resume = deferred();
  const write = jest.fn(async () => {});
  const pending = withSubscriptionOperation(
    "cus_test",
    "cancel",
    async (guard) => {
      started.resolve();
      await resume.promise;
      await guard.write(write);
    },
  );
  await started.promise;
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
  await (operations.begin as any).handler(ctx, {
    serviceKey: "test",
    stripeCustomerId: "cus_test",
    token: "successor",
    operation: "keep",
  });
  resume.resolve();
  await expect(pending).rejects.toThrow(
    BILLING_ERRORS.subscriptionChangeInProgress,
  );
  expect(write).not.toHaveBeenCalled();
  expect(rows[0].token).toBe("successor");
});

it("rejects a stale read-only result after its preflight claim expires", async () => {
  const pending = withSubscriptionOperation("cus_test", "keep", async () => {
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    return { alreadyKept: true };
  });
  await expect(pending).rejects.toThrow(
    BILLING_ERRORS.subscriptionChangeInProgress,
  );
});
