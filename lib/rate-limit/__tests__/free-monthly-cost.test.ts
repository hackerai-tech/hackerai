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
  const originalEnv = process.env.FREE_MONTHLY_COST_LIMIT_USD;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    mockGet.mockResolvedValue(null);
    mockEval.mockResolvedValue(1);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    } else {
      process.env.FREE_MONTHLY_COST_LIMIT_USD = originalEnv;
    }
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../free-monthly-cost");

    jest.isolateModules(() => {
      jest.doMock("../redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));

      isolatedModule = require("../free-monthly-cost");
    });

    return isolatedModule!;
  };

  it("checks the default $0.25 monthly free cost cap", async () => {
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
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
  });

  it("throws a rate-limit error when the monthly free cost cap is exhausted", async () => {
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.01";
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    mockGet.mockResolvedValue(100);
    const { checkFreeMonthlyCostLimit } = getIsolatedModule();

    await expect(checkFreeMonthlyCostLimit("user-123")).rejects.toMatchObject({
      type: "rate_limit",
      surface: "chat",
      cause: expect.stringContaining("free monthly usage"),
    });
  });

  it("records actual free usage cost as monthly points", async () => {
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
    const { recordFreeMonthlyCost } = getIsolatedModule();

    await recordFreeMonthlyCost("user-123", 0.0123);

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      [expect.stringMatching(/^free_monthly_cost:user-123:\d{4}-\d{2}$/)],
      [123, expect.any(Number)],
    );
  });

  it("can key free monthly usage by privacy-safe quota subject", async () => {
    mockCreateRedisClient.mockReturnValue({ get: mockGet, eval: mockEval });
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
