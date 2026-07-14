import {
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
} from "../included-usage";
import { runPro20UsageBackfill } from "../pro-20-usage-backfill";

const periodEnd = 1_800_000_000;

function makeDependencies({ liveMode = true }: { liveMode?: boolean } = {}) {
  const activeSubscription = {
    id: "sub_current",
    customer: "cus_current",
    items: { data: [{ current_period_end: periodEnd }] },
  };
  const subscriptionsList = jest.fn(async ({ price, status }) => ({
    data:
      price === HACKERAI_PRO_20_MONTHLY_PRICE_ID && status === "active"
        ? [activeSubscription]
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
        metadata: { workOSOrganizationId: "org_current" },
      })),
    },
  };
  const workos = {
    userManagement: {
      listOrganizationMemberships: jest.fn(async () => ({
        autoPagination: async () => [{ userId: "user_current" }],
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
});
