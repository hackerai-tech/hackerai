const mockGetUserIDAndPro = jest.fn();
const mockGetUserCustomization = jest.fn();
const mockBuildExtraUsageConfig = jest.fn();
const mockEvaluateFlags = jest.fn();
const mockCapture = jest.fn();
const mockShutdownPostHog = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn(
      (body: unknown, init?: { headers?: Record<string, string> }) => ({
        json: async () => body,
        headers: {
          get: (name: string) =>
            Object.entries(init?.headers ?? {}).find(
              ([header]) => header.toLowerCase() === name.toLowerCase(),
            )?.[1] ?? null,
        },
      }),
    ),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));
jest.mock("@/lib/db/actions", () => ({
  getUserCustomization: (...args: unknown[]) =>
    mockGetUserCustomization(...args),
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  buildExtraUsageConfig: (...args: unknown[]) =>
    mockBuildExtraUsageConfig(...args),
}));
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    evaluateFlags: (...args: unknown[]) => mockEvaluateFlags(...args),
    capture: (...args: unknown[]) => mockCapture(...args),
  }),
}));
jest.mock("@/lib/api/chat-logger", () => ({
  shutdownPostHog: (...args: unknown[]) => mockShutdownPostHog(...args),
}));

const { GET } = jest.requireActual<typeof import("../route")>("../route");

const request = {} as Parameters<typeof GET>[0];

describe("GET /api/experiments/pro-plus-max-access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserCustomization.mockResolvedValue({});
    mockBuildExtraUsageConfig.mockResolvedValue(undefined);
    mockEvaluateFlags.mockResolvedValue({
      getFlag: () => "included_max",
    });
  });

  it("returns the server-evaluated treatment for eligible Pro+ users", async () => {
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro-plus",
      organizationId: "org_123",
    });

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({
      eligible: true,
      experimentKey: "pro_plus_included_max_access_v1",
      variant: "included_max",
      includedMaxAccess: true,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hac59_pro_plus_max_access_experiment_exposed",
      }),
    );
    expect(mockShutdownPostHog).toHaveBeenCalledTimes(1);
  });

  it.each(["free", "pro", "ultra", "team"])(
    "fails closed without evaluating the flag for %s users",
    async (subscription) => {
      mockGetUserIDAndPro.mockResolvedValue({
        userId: "user_123",
        subscription,
      });

      const response = await GET(request);

      await expect(response.json()).resolves.toEqual({
        eligible: false,
        includedMaxAccess: false,
      });
      expect(mockEvaluateFlags).not.toHaveBeenCalled();
    },
  );

  it("does not enroll Pro+ users who already have usable Extra Usage", async () => {
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro-plus",
    });
    mockBuildExtraUsageConfig.mockResolvedValue({
      enabled: true,
      hasBalance: true,
      autoReloadEnabled: false,
    });

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({
      eligible: false,
      includedMaxAccess: false,
    });
    expect(mockEvaluateFlags).not.toHaveBeenCalled();
  });
});
