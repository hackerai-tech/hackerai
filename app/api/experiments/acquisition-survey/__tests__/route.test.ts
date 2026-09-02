const mockGetUserIDAndPro = jest.fn();
const mockGetPostHogFeatureFlagForUser = jest.fn();

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

jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagForUser: (...args: unknown[]) =>
    mockGetPostHogFeatureFlagForUser(...args),
}));

const { GET } = jest.requireActual<typeof import("../route")>("../route");
const request = {} as Parameters<typeof GET>[0];

describe("GET /api/experiments/acquisition-survey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" });
    mockGetPostHogFeatureFlagForUser.mockResolvedValue(false);
  });

  it("returns the server-evaluated assignment without caching", async () => {
    mockGetPostHogFeatureFlagForUser.mockResolvedValue(true);

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({ available: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockGetPostHogFeatureFlagForUser).toHaveBeenCalledWith(
      "hac-57-post-activation-survey",
      "user-1",
    );
  });

  it("fails closed when authentication or flag evaluation fails", async () => {
    mockGetUserIDAndPro.mockRejectedValue(new Error("unauthorized"));

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({ available: false });
  });
});
