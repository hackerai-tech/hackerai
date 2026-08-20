const mockGetUserIDAndPro = jest.fn();

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

const { GET } = jest.requireActual<typeof import("../route")>("../route");
const request = {} as Parameters<typeof GET>[0];

describe("GET /api/experiments/agent-auto-review", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" });
  });

  it("returns the default enforced assignment for authenticated users", async () => {
    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({
      available: true,
      phase: "enforce",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed when authentication fails", async () => {
    mockGetUserIDAndPro.mockRejectedValue(new Error("unauthorized"));

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({
      available: false,
    });
  });
});
