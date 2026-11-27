import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/app/api/stripe", () => ({ stripe: {} }));
jest.mock("@/app/api/workos", () => ({ workos: {} }));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: () => null }));

import {
  ProMonthlyPriceUnavailableError,
  resolveProMonthlyQuote,
  type Hac248Deps,
} from "@/lib/experiments/pro-monthly-pricing-hac248.server";

const USER_ID = "user_new";
const STORAGE_KEY = `hac248:pro-monthly:proposal:${USER_ID}`;
const NOW = "2026-11-20T10:00:00.000Z";

function controlPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: "price_pro_29",
    active: true,
    lookup_key: "pro-monthly-plan",
    currency: "usd",
    unit_amount: 2900,
    billing_scheme: "per_unit",
    type: "recurring",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    product: "prod_pro",
    custom_unit_amount: null,
    transform_quantity: null,
    tiers_mode: null,
    ...overrides,
  };
}

function testPrice(overrides: Record<string, unknown> = {}) {
  return controlPrice({
    id: "price_pro_49",
    lookup_key: "pro-monthly-plan-49-hac248",
    unit_amount: 4900,
    ...overrides,
  });
}

function storedAssignment(variant: "control" | "test") {
  return JSON.stringify({
    version: 1,
    key: "hac248-pro-monthly-49-pricing-proposal",
    variant,
    priceLookupKey:
      variant === "test" ? "pro-monthly-plan-49-hac248" : "pro-monthly-plan",
    displayedAmountDollars: variant === "test" ? 49 : 29,
    stripePriceId: variant === "test" ? "price_pro_49" : "price_pro_29",
    assignedAt: "2026-11-19T08:00:00.000Z",
  });
}

function setup({
  variant = "test",
  createdAt = "2026-11-19T00:00:00.000Z",
  testPriceOverrides = {},
  controlPriceOverrides = {},
}: {
  variant?: string;
  createdAt?: string;
  testPriceOverrides?: Record<string, unknown>;
  controlPriceOverrides?: Record<string, unknown>;
} = {}) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _options: unknown) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
  };
  const posthog = {
    getFeatureFlagResult: jest.fn(async (..._args: unknown[]) => ({
      key: "hac248-pro-monthly-49-pricing-proposal",
      enabled: true,
      variant,
      payload: { version: 1, enrollmentStartAt: "2026-11-18T00:00:00.000Z" },
    })),
    capture: jest.fn((_message: unknown) => {}),
    flush: jest.fn(async () => {}),
  };
  const stripe = {
    prices: {
      list: jest.fn(async ({ lookup_keys }: { lookup_keys: string[] }) => ({
        data: [
          lookup_keys[0] === "pro-monthly-plan"
            ? controlPrice(controlPriceOverrides)
            : testPrice(testPriceOverrides),
        ],
      })),
      retrieve: jest.fn(async (id: string) =>
        id === "price_pro_49"
          ? testPrice(testPriceOverrides)
          : controlPrice(controlPriceOverrides),
      ),
    },
    customers: {
      list: jest.fn(async (_params: unknown) => ({
        data: [] as { id: string }[],
        has_more: false,
      })),
    },
    subscriptions: {
      list: jest.fn(async (_params: unknown) => ({
        data: [] as unknown[],
        has_more: false,
      })),
    },
  };
  const workos = {
    userManagement: {
      getUser: jest.fn(async (_userId: string) => ({
        email: "new@example.com",
        createdAt,
      })),
      listOrganizationMemberships: jest.fn(async (_options: unknown) => ({
        data: [{ organizationId: "org_1" }],
        listMetadata: { after: null as string | null },
      })),
    },
    organizations: {
      getOrganization: jest.fn(async (_organizationId: string) => ({
        stripeCustomerId: "cus_1" as string | null,
      })),
    },
  };
  const deps = {
    redis,
    posthog,
    stripe,
    workos,
    now: () => new Date(NOW),
  } as unknown as Hac248Deps;
  const resolve = (args: { subscription?: string; enroll?: boolean } = {}) =>
    resolveProMonthlyQuote({
      userId: USER_ID,
      subscription: args.subscription ?? "free",
      enroll: args.enroll ?? true,
      deps,
    });
  return { store, redis, posthog, stripe, workos, deps, resolve };
}

describe("resolveProMonthlyQuote", () => {
  it("assigns an eligible new free account once, durably and without expiry", async () => {
    const { resolve, redis, posthog, store } = setup();

    const first = await resolve();
    expect(first.price).toMatchObject({
      displayedAmountDollars: 49,
      stripePriceId: "price_pro_49",
    });
    expect(first.stripePrice.id).toBe("price_pro_49");
    expect(first.assignment).toMatchObject({
      variant: "test",
      assignedAt: NOW,
    });
    expect(redis.set).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String), {
      nx: true,
    });
    expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
      "hac248-pro-monthly-49-pricing-proposal",
      USER_ID,
      { sendFeatureFlagEvents: false },
    );
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hac248_pro_monthly_pricing_enrolled",
        distinctId: USER_ID,
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );

    const again = await resolve();
    expect(again.assignment).toEqual(first.assignment);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("retries a failed enrollment event later with the same ID and original time, keeping the quote", async () => {
    const { resolve, posthog } = setup();
    posthog.flush.mockRejectedValueOnce(new Error("PostHog down") as never);

    const first = await resolve();
    expect(first.price.displayedAmountDollars).toBe(49);

    // Enrollment is switched off before the next pricing view.
    posthog.getFeatureFlagResult.mockResolvedValue({ enabled: false } as never);
    const later = await resolve();
    expect(later.assignment).toEqual(first.assignment);
    expect(later.price.displayedAmountDollars).toBe(49);

    expect(posthog.capture).toHaveBeenCalledTimes(2);
    const [original, retried] = posthog.capture.mock.calls.map(
      ([message]) =>
        message as { event: string; uuid: string; timestamp: Date },
    );
    expect(retried.event).toBe("hac248_pro_monthly_pricing_enrolled");
    expect(retried.uuid).toBe(original.uuid);
    expect(retried.timestamp.toISOString()).toBe(NOW);
    expect(original.timestamp.toISOString()).toBe(NOW);
  });

  it("keeps the quote when the enrollment event cannot be captured", async () => {
    const { resolve, store, posthog } = setup();
    store.set(STORAGE_KEY, storedAssignment("test"));
    posthog.capture.mockImplementation(() => {
      throw new Error("PostHog unavailable");
    });
    const quote = await resolve();
    expect(quote.price.displayedAmountDollars).toBe(49);
  });

  it("keeps a recorded $49 quote after new enrollment is switched off", async () => {
    const { resolve, store, posthog } = setup();
    store.set(STORAGE_KEY, storedAssignment("test"));
    posthog.getFeatureFlagResult.mockResolvedValue({
      enabled: false,
    } as never);

    const quote = await resolve();
    expect(quote.price.displayedAmountDollars).toBe(49);
    expect(quote.assignment?.assignedAt).toBe("2026-11-19T08:00:00.000Z");
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
  });

  it("keeps a recorded $49 quote for a later paid account", async () => {
    const { resolve, store } = setup();
    store.set(STORAGE_KEY, storedAssignment("test"));
    const quote = await resolve({ subscription: "pro" });
    expect(quote.price.displayedAmountDollars).toBe(49);
  });

  it("keeps accounts created before the enrollment start at $29", async () => {
    const { resolve, redis } = setup({ createdAt: "2026-11-17T23:59:59.000Z" });
    const quote = await resolve();
    expect(quote.price).toMatchObject({
      displayedAmountDollars: 29,
      stripePriceId: "price_pro_29",
    });
    expect(quote.assignment).toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    ["a paid account", { subscription: "pro" }],
    ["a background lookup", { enroll: false }],
  ])("never enrolls %s", async (_label, args) => {
    const { resolve, redis, posthog } = setup();
    const quote = await resolve(args);
    expect(quote.price.displayedAmountDollars).toBe(29);
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a previous subscription or trial on a membership",
      (s: ReturnType<typeof setup>) =>
        s.stripe.subscriptions.list.mockResolvedValue({
          data: [{ status: "canceled" }],
          has_more: false,
        }),
    ],
    [
      "a subscription under a customer with the same email",
      (s: ReturnType<typeof setup>) => {
        s.workos.organizations.getOrganization.mockResolvedValue({
          stripeCustomerId: null,
        } as never);
        s.stripe.customers.list.mockResolvedValue({
          data: [{ id: "cus_email" }],
          has_more: false,
        });
        s.stripe.subscriptions.list.mockImplementation(
          async (params: unknown) => ({
            data:
              (params as { customer: string }).customer === "cus_email"
                ? [{ status: "trialing" }]
                : [],
            has_more: false,
          }),
        );
      },
    ],
    [
      "more memberships than can be verified",
      (s: ReturnType<typeof setup>) =>
        s.workos.userManagement.listOrganizationMemberships.mockResolvedValue({
          data: [{ organizationId: "org_1" }],
          listMetadata: { after: "cursor" },
        }),
    ],
    [
      "billing history that cannot be read",
      (s: ReturnType<typeof setup>) =>
        s.workos.organizations.getOrganization.mockRejectedValue(
          new Error("WorkOS unavailable") as never,
        ),
    ],
    [
      "a flag without a valid enrollment start",
      (s: ReturnType<typeof setup>) =>
        s.posthog.getFeatureFlagResult.mockResolvedValue({
          enabled: true,
          variant: "test",
          payload: { version: 1 },
        } as never),
    ],
    [
      "a $49 Price that sells a different Product",
      (s: ReturnType<typeof setup>) =>
        s.stripe.prices.list.mockImplementation(
          async ({ lookup_keys }: { lookup_keys: string[] }) => ({
            data: [
              lookup_keys[0] === "pro-monthly-plan"
                ? controlPrice()
                : testPrice({ product: "prod_other" }),
            ],
          }),
        ),
    ],
  ])(
    "keeps the current $29 price without enrolling for %s",
    async (_l, arrange) => {
      const state = setup();
      arrange(state);
      const quote = await state.resolve();
      expect(quote.price.displayedAmountDollars).toBe(29);
      expect(quote.assignment).toBeUndefined();
      expect(state.redis.set).not.toHaveBeenCalled();
      expect(state.posthog.capture).not.toHaveBeenCalled();
    },
  );

  it("uses the stored winner when another request enrolled the account first", async () => {
    const state = setup({ variant: "test" });
    state.redis.set.mockImplementation(async (key: string) => {
      state.store.set(key, storedAssignment("control"));
      return null;
    });
    const quote = await state.resolve();
    expect(quote.assignment?.variant).toBe("control");
    expect(quote.price.displayedAmountDollars).toBe(29);
    // Only the winner's original assignment is reported, at its original time.
    expect(state.posthog.capture).toHaveBeenCalledTimes(1);
    expect(state.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hac248_pro_monthly_pricing_enrolled",
        timestamp: new Date("2026-11-19T08:00:00.000Z"),
        properties: expect.objectContaining({ experiment_variant: "control" }),
      }),
    );
  });

  it.each([
    [
      "the enrollment flag check",
      (s: ReturnType<typeof setup>) =>
        s.posthog.getFeatureFlagResult.mockImplementation(async () => {
          // Another request enrolls this account mid-check; this one is off.
          s.store.set(STORAGE_KEY, storedAssignment("test"));
          return { enabled: false } as never;
        }),
    ],
    [
      "the billing history check",
      (s: ReturnType<typeof setup>) =>
        s.workos.organizations.getOrganization.mockImplementation(async () => {
          s.store.set(STORAGE_KEY, storedAssignment("test"));
          throw new Error("WorkOS unavailable");
        }),
    ],
  ])(
    "returns the concurrently stored $49 assignment when eligibility fails during %s",
    async (_label, arrange) => {
      const state = setup();
      arrange(state);
      const quote = await state.resolve();
      expect(quote.price).toMatchObject({
        displayedAmountDollars: 49,
        stripePriceId: "price_pro_49",
      });
      expect(quote.stripePrice.id).toBe("price_pro_49");
      expect(quote.assignment).toEqual(JSON.parse(storedAssignment("test")));
      expect(state.redis.set).not.toHaveBeenCalled();
      // The winner's original enrollment event, not a new one.
      expect(state.posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "hac248_pro_monthly_pricing_enrolled",
          timestamp: new Date("2026-11-19T08:00:00.000Z"),
        }),
      );
    },
  );

  it("still fails closed when the re-read after a failed eligibility check cannot reach storage", async () => {
    const state = setup({ createdAt: "2026-11-17T00:00:00.000Z" });
    state.redis.get
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Redis down") as never);
    await expect(state.resolve()).rejects.toBeInstanceOf(
      ProMonthlyPriceUnavailableError,
    );
  });

  it.each([
    [
      "storage is unreachable",
      (s: ReturnType<typeof setup>) =>
        s.redis.get.mockRejectedValue(new Error("Redis down") as never),
    ],
    [
      "the stored assignment is corrupt",
      (s: ReturnType<typeof setup>) => s.store.set(STORAGE_KEY, "{not json"),
    ],
    [
      "the stored $49 Price no longer validates",
      (s: ReturnType<typeof setup>) => {
        s.store.set(STORAGE_KEY, storedAssignment("test"));
        s.stripe.prices.retrieve.mockResolvedValue(
          testPrice({ unit_amount: 3900 }) as never,
        );
      },
    ],
    [
      "the control lookup no longer sells $29",
      (s: ReturnType<typeof setup>) =>
        s.stripe.prices.list.mockResolvedValue({
          data: [controlPrice({ unit_amount: 2500 })],
        } as never),
    ],
  ])(
    "fails closed instead of quoting or reassigning when %s",
    async (_l, arrange) => {
      const state = setup();
      arrange(state);
      await expect(state.resolve()).rejects.toBeInstanceOf(
        ProMonthlyPriceUnavailableError,
      );
      expect(state.redis.set).not.toHaveBeenCalled();
    },
  );

  it("fails closed when assignment storage is not configured", async () => {
    const state = setup();
    await expect(
      resolveProMonthlyQuote({
        userId: USER_ID,
        subscription: "free",
        enroll: true,
        deps: { ...state.deps, redis: null },
      }),
    ).rejects.toBeInstanceOf(ProMonthlyPriceUnavailableError);
  });
});
