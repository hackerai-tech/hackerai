import {
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
} from "../included-usage";
import {
  applyBackfill,
  runPro20UsageBackfill,
  type BackfillTarget,
} from "../pro-20-usage-backfill";

const periodEnd = 1_800_000_000;

type FakeSubscription = {
  id: string;
  customer: string;
  items: {
    data: Array<{
      price: { id: string };
      current_period_end: number;
    }>;
  };
};

function makeSubscription(
  id: string,
  itemPeriodEnd: number,
  extraItemPeriodEnd?: number,
): FakeSubscription {
  return {
    id,
    customer: `cus_${id}`,
    items: {
      data: [
        {
          price: { id: HACKERAI_PRO_20_MONTHLY_PRICE_ID },
          current_period_end: itemPeriodEnd,
        },
        ...(extraItemPeriodEnd === undefined
          ? []
          : [
              {
                price: { id: "price_add_on" },
                current_period_end: extraItemPeriodEnd,
              },
            ]),
      ],
    },
  };
}

function makeDependencies({
  liveMode = true,
  activeSubscriptions = [makeSubscription("sub_current", periodEnd)],
  organizationId = "org_current",
  userIds = ["user_current"],
}: {
  liveMode?: boolean;
  activeSubscriptions?: FakeSubscription[];
  organizationId?: string | null;
  userIds?: string[];
} = {}) {
  const subscriptionsList = jest.fn(async ({ price, status }) => ({
    data:
      price === HACKERAI_PRO_20_MONTHLY_PRICE_ID && status === "active"
        ? activeSubscriptions
        : [],
    has_more: false,
  }));
  const stripe = {
    prices: {
      retrieve: jest.fn(async (priceId: string) => ({
        id: priceId,
        livemode: liveMode,
      })),
    },
    subscriptions: { list: subscriptionsList },
    customers: {
      retrieve: jest.fn(async () => ({
        deleted: false,
        metadata: organizationId
          ? { workOSOrganizationId: organizationId }
          : {},
      })),
    },
  };
  const workos = {
    userManagement: {
      listOrganizationMemberships: jest.fn(async () => ({
        autoPagination: async () => userIds.map((userId) => ({ userId })),
      })),
    },
  };
  const capAllocation = jest.fn(async () => ({
    created: false,
    previousAllocation: 250_000,
    previousRemaining: 150_000,
    targetAllocation: 200_000,
    targetRemaining: 100_000,
    pointsRemoved: 50_000,
  }));

  return { stripe, workos, capAllocation };
}

describe("runPro20UsageBackfill", () => {
  it("builds a live dry-run snapshot without Redis writes", async () => {
    const { stripe, workos, capAllocation } = makeDependencies();

    const result = await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      capAllocation: capAllocation as never,
    });

    expect(result.summary).toMatchObject({
      mode: "dry-run",
      stripeLiveMode: true,
      currentPriceActiveSubscriptions: 1,
      eligibleSubscriptions: 1,
      eligibleUsers: 1,
      unmappedActiveSubscriptions: 0,
      legacyPriceActiveSubscriptions: 0,
      targetIncludedUsagePoints: 200_000,
    });
    expect(result.summary.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(stripe.prices.retrieve).toHaveBeenCalledWith(
      PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
    );
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("rejects Stripe test mode before listing subscriptions", async () => {
    const { stripe, workos, capAllocation } = makeDependencies({
      liveMode: false,
    });

    await expect(
      runPro20UsageBackfill({
        stripe: stripe as never,
        workos: workos as never,
        capAllocation: capAllocation as never,
      }),
    ).rejects.toThrow("Stripe test mode");
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("rejects target churn before Redis writes", async () => {
    const { stripe, workos, capAllocation } = makeDependencies();

    await expect(
      runPro20UsageBackfill({
        stripe: stripe as never,
        workos: workos as never,
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "stale-fingerprint",
        capAllocation: capAllocation as never,
      }),
    ).rejects.toThrow("expected target fingerprint");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("applies the exact reviewed snapshot", async () => {
    const { stripe, workos, capAllocation } = makeDependencies();
    const dryRun = await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      capAllocation: capAllocation as never,
    });

    const result = await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      apply: true,
      expectedSubscriptions: 1,
      expectedFingerprint: dryRun.summary.targetFingerprint,
      capAllocation: capAllocation as never,
    });

    expect(capAllocation).toHaveBeenCalledTimes(1);
    expect(capAllocation).toHaveBeenCalledWith(
      "user_current",
      "pro",
      200_000,
      periodEnd,
    );
    expect(result.applyResult).toEqual({
      applied: true,
      usersProcessed: 1,
      bucketsCreated: 0,
      pointsRemoved: 50_000,
    });
  });

  it("uses the matching Pro price cycle instead of an add-on cycle", async () => {
    const { stripe, workos, capAllocation } = makeDependencies({
      activeSubscriptions: [
        makeSubscription("sub_current", periodEnd, periodEnd + 86_400),
      ],
    });
    const dryRun = await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      capAllocation: capAllocation as never,
    });

    await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      apply: true,
      expectedSubscriptions: 1,
      expectedFingerprint: dryRun.summary.targetFingerprint,
      capAllocation: capAllocation as never,
    });

    expect(capAllocation).toHaveBeenCalledWith(
      "user_current",
      "pro",
      200_000,
      periodEnd,
    );
  });

  it("reports an unmapped organization and prevents apply writes", async () => {
    const { stripe, workos, capAllocation } = makeDependencies({
      organizationId: null,
    });
    const dryRun = await runPro20UsageBackfill({
      stripe: stripe as never,
      workos: workos as never,
      capAllocation: capAllocation as never,
    });

    expect(dryRun.summary).toMatchObject({
      eligibleSubscriptions: 0,
      unmappedActiveSubscriptions: 1,
    });
    await expect(
      runPro20UsageBackfill({
        stripe: stripe as never,
        workos: workos as never,
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: dryRun.summary.targetFingerprint,
        capAllocation: capAllocation as never,
      }),
    ).rejects.toThrow("could not be mapped");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("rejects conflicting user cycle ends before allocation writes", async () => {
    const { stripe, workos, capAllocation } = makeDependencies({
      activeSubscriptions: [
        makeSubscription("sub_first", periodEnd),
        makeSubscription("sub_second", periodEnd + 86_400),
      ],
    });

    await expect(
      runPro20UsageBackfill({
        stripe: stripe as never,
        workos: workos as never,
        capAllocation: capAllocation as never,
      }),
    ).rejects.toThrow("conflicting subscription period ends");
    expect(capAllocation).not.toHaveBeenCalled();
  });
});

describe("applyBackfill preflight", () => {
  const capAllocation = jest.fn(async () => ({
    created: false,
    previousAllocation: 250_000,
    previousRemaining: 150_000,
    targetAllocation: 200_000,
    targetRemaining: 100_000,
    pointsRemoved: 50_000,
  }));

  beforeEach(() => {
    capAllocation.mockClear();
  });

  it("rejects a missing subscription period before writes", async () => {
    const missingPeriodEnd = { userIds: ["user_1"] } as BackfillTarget;

    await expect(
      applyBackfill(
        {
          activeSubscriptionCount: 1,
          expectedSubscriptions: 1,
          targets: [missingPeriodEnd],
          unmapped: 0,
        },
        capAllocation as never,
      ),
    ).rejects.toThrow("missing subscription period end");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("rejects a changed live subscription count before writes", async () => {
    await expect(
      applyBackfill(
        {
          activeSubscriptionCount: 2,
          expectedSubscriptions: 1,
          targets: [
            { periodEnd, userIds: ["user_1"] },
            { periodEnd, userIds: ["user_2"] },
          ],
          unmapped: 0,
        },
        capAllocation as never,
      ),
    ).rejects.toThrow("expected 1 active subscriptions, found 2");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("deduplicates one user with a consistent cycle end", async () => {
    const result = await applyBackfill(
      {
        activeSubscriptionCount: 2,
        expectedSubscriptions: 2,
        targets: [
          { periodEnd, userIds: ["user_1"] },
          { periodEnd, userIds: ["user_1"] },
        ],
        unmapped: 0,
      },
      capAllocation as never,
    );

    expect(capAllocation).toHaveBeenCalledTimes(1);
    expect(result.usersProcessed).toBe(1);
  });
});
