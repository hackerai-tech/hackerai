import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

describe("free monthly cost limit", () => {
  const mockCreateRedisClient = jest.fn();
  const mockGet = jest.fn();
  const mockEval = jest.fn();
  const mockSet = jest.fn();
  const mockGetFeatureFlagVariantForUser = jest.fn();
  const mockPostHogEvent = jest.fn();
  const originalEnv = process.env.FREE_MONTHLY_COST_LIMIT_USD;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    mockGet.mockResolvedValue(null);
    mockEval.mockResolvedValue(1);
    mockSet.mockResolvedValue("OK");
    mockGetFeatureFlagVariantForUser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    } else {
      process.env.FREE_MONTHLY_COST_LIMIT_USD = originalEnv;
    }
    jest.useRealTimers();
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../free-monthly-cost");

    jest.isolateModules(() => {
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));
      jest.doMock("@/lib/posthog/server", () => ({
        getPostHogFeatureFlagVariantForUser: mockGetFeatureFlagVariantForUser,
        phLogger: { event: mockPostHogEvent },
      }));

      isolatedModule = require("../free-monthly-cost");
    });

    return isolatedModule!;
  };

  it("checks the default $0.25 monthly free cost cap", async () => {
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    mockGet.mockResolvedValue(1250);
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit("user-123");

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringMatching(/^free_monthly_cost:user-123:\d{4}-\d{2}$/),
    );
    expect(snapshot.monthlyLimitPoints).toBe(2500);
    expect(snapshot.monthlyRemainingAtStart).toBe(1250);
    expect(snapshot.extraUsageBalanceAtStart).toBe(0);
    expect(snapshot.extraUsageAutoReload).toBe(false);
    expect(mockGetFeatureFlagVariantForUser).toHaveBeenCalledWith(
      "free_usage_budget_v1",
      "user-123",
    );
  });

  it("keeps the current $0.25 cap in a treatment user's first exposed month", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T12:00:00Z"));
    mockGetFeatureFlagVariantForUser.mockResolvedValue("test");
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
    );

    expect(snapshot.monthlyLimitPoints).toBe(2500);
    expect(mockSet).toHaveBeenCalledWith(
      "free_usage_budget_started:v1:free_quota:v1:subject",
      "2026-08",
      { nx: true },
    );
  });

  it("captures the applied treatment policy and enforcement surface", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T12:00:00Z"));
    mockGetFeatureFlagVariantForUser.mockResolvedValue("test");
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
      "trigger_agent_long",
    );

    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "free_usage_budget_enforcement",
      expect.objectContaining({
        userId: "user-123",
        experiment_key: "free_usage_budget_v1",
        policy_version: 1,
        enforcement_surface: "trigger_agent_long",
        enforcement_result: "allowed",
        variant: "test",
        budget_phase: "activation",
        budget_month: "2026-08",
        monthly_limit_dollars: 0.25,
        monthly_used_dollars: 0,
        monthly_remaining_dollars: 0.25,
      }),
    );
  });

  it("uses the $0.15 recurring cap after a treatment user's first month", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T12:00:00Z"));
    mockGetFeatureFlagVariantForUser.mockResolvedValue("test");
    mockGet.mockImplementation(async (key: string) =>
      key.startsWith("free_usage_budget_started:") ? "2026-07" : 0,
    );
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
    );

    expect(snapshot.monthlyLimitPoints).toBe(1500);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("keeps the first-month cap when another request wins marker initialization", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T12:00:00Z"));
    mockGetFeatureFlagVariantForUser.mockResolvedValue("test");
    mockGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("2026-08")
      .mockResolvedValueOnce(0);
    mockSet.mockResolvedValue(null);
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
    );

    expect(snapshot.monthlyLimitPoints).toBe(2500);
    expect(mockSet).toHaveBeenCalledWith(
      "free_usage_budget_started:v1:free_quota:v1:subject",
      "2026-08",
      { nx: true },
    );
  });

  it("fails safely to the current cap when experiment evaluation is unavailable", async () => {
    mockGetFeatureFlagVariantForUser.mockResolvedValue(undefined);
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
    );

    expect(snapshot.monthlyLimitPoints).toBe(2500);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("identifies unresolved assignments as safe fallbacks", async () => {
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    await checkFreeMonthlyCostLimit(
      "free_quota:v1:subject",
      "user-123",
      "api_chat",
    );

    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "free_usage_budget_enforcement",
      expect.objectContaining({
        enforcement_surface: "api_chat",
        variant: "unresolved",
        budget_phase: "safe_fallback",
        fallback_reason: "variant_unresolved",
        monthly_limit_dollars: 0.25,
      }),
    );
  });

  it("throws a rate-limit error when the monthly free cost cap is exhausted", async () => {
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.01";
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    mockGet.mockResolvedValue(100);
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    await expect(
      checkFreeMonthlyCostLimit("user-123", "user-123", "trigger_subagent"),
    ).rejects.toMatchObject({
      type: "rate_limit",
      surface: "chat",
      cause: expect.stringContaining("free monthly usage"),
    });
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "free_usage_budget_enforcement",
      expect.objectContaining({
        enforcement_surface: "trigger_subagent",
        enforcement_result: "blocked",
        monthly_remaining_dollars: 0,
      }),
    );
  });

  it("records actual free usage cost as monthly points", async () => {
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { recordFreeMonthlyCost } = getIsolatedModule();

    await recordFreeMonthlyCost("user-123", 0.0123);

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      [expect.stringMatching(/^free_monthly_cost:user-123:\d{4}-\d{2}$/)],
      [123, expect.any(Number)],
    );
  });

  it("can key free monthly usage by privacy-safe quota subject", async () => {
    mockCreateRedisClient.mockReturnValue({
      get: mockGet,
      eval: mockEval,
      set: mockSet,
    });
    const { checkFreeMonthlyCostLimit, recordFreeMonthlyCost } =
      getIsolatedModule();
    const subject =
      "free_quota:v1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    await checkFreeMonthlyCostLimit(subject);
    await recordFreeMonthlyCost(subject, 0.01);

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringMatching(
        /^free_monthly_cost:free_quota:v1:[a-f0-9]+:\d{4}-\d{2}$/,
      ),
    );
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.stringMatching(
          /^free_monthly_cost:free_quota:v1:[a-f0-9]+:\d{4}-\d{2}$/,
        ),
      ],
      [100, expect.any(Number)],
    );
  });

  it("skips checks outside production when Redis is unavailable", async () => {
    mockCreateRedisClient.mockReturnValue(null);
    const { checkFreeMonthlyCostLimit, recordFreeMonthlyCost } =
      getIsolatedModule();

    const snapshot = await checkFreeMonthlyCostLimit("user-123");

    expect(snapshot.rateLimitSkipped).toBe(true);
    await expect(
      recordFreeMonthlyCost("user-123", 0.01),
    ).resolves.toBeUndefined();
  });
});
