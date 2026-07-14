import {
  applyBackfill,
  parseBackfillArgs,
  type BackfillTarget,
} from "../backfill-pro-20-usage";

describe("backfill-pro-20-usage arguments", () => {
  it("defaults to dry-run", () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      envFile: ".env.local",
    });
  });

  it("requires an expected subscription count when applying", () => {
    expect(() => parseBackfillArgs(["--apply"])).toThrow(
      "--apply requires --expected-subscriptions",
    );
  });

  it("accepts an explicit environment file and safety count", () => {
    expect(
      parseBackfillArgs([
        "--env-file=/tmp/production.env",
        "--apply",
        "--expected-subscriptions=105",
      ]),
    ).toEqual({
      apply: true,
      envFile: "/tmp/production.env",
      expectedSubscriptions: 105,
    });
  });
});

describe("backfill-pro-20-usage preflight", () => {
  const periodEnd = 1_800_000_000;
  const capAllocation = jest.fn().mockResolvedValue({
    created: false,
    previousAllocation: 250_000,
    previousRemaining: 150_000,
    targetAllocation: 200_000,
    targetRemaining: 100_000,
    pointsRemoved: 50_000,
  });

  beforeEach(() => {
    capAllocation.mockClear();
  });

  it("performs no writes when a subscription is unmapped", async () => {
    await expect(
      applyBackfill(
        {
          activeSubscriptionCount: 1,
          expectedSubscriptions: 1,
          targets: [],
          unmapped: 1,
        },
        capAllocation as never,
      ),
    ).rejects.toThrow("could not be mapped");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("performs no writes when a period end is missing", async () => {
    const missingPeriodEnd = {
      userIds: ["user_1"],
    } as BackfillTarget;

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

  it("performs no writes when one user has conflicting cycle ends", async () => {
    await expect(
      applyBackfill(
        {
          activeSubscriptionCount: 2,
          expectedSubscriptions: 2,
          targets: [
            { periodEnd, userIds: ["user_1"] },
            { periodEnd: periodEnd + 100, userIds: ["user_1"] },
          ],
          unmapped: 0,
        },
        capAllocation as never,
      ),
    ).rejects.toThrow("conflicting subscription period ends");
    expect(capAllocation).not.toHaveBeenCalled();
  });

  it("performs no writes when the live count changed after dry-run", async () => {
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

  it("deduplicates the same user with a consistent cycle end", async () => {
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
    expect(capAllocation).toHaveBeenCalledWith(
      "user_1",
      "pro",
      200_000,
      periodEnd,
    );
    expect(result).toEqual({
      applied: true,
      usersProcessed: 1,
      bucketsCreated: 0,
      pointsRemoved: 50_000,
    });
  });
});
