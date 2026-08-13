const mockGetUserIDAndPro = jest.fn();
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

describe("GET /api/experiments/agent-auto-review", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" });
  });

  it.each(["shadow", "enforce"] as const)(
    "returns the server-evaluated %s assignment",
    async (phase) => {
      mockEvaluateFlags.mockResolvedValue({ getFlag: () => phase });

      const response = await GET(request);

      await expect(response.json()).resolves.toEqual({
        available: true,
        flagKey: "agent_auto_review_v1",
        phase,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "agent_auto_review_exposed",
          properties: expect.objectContaining({
            rollout_phase: phase,
            surface: "agent_permission_selector",
          }),
        }),
      );
      expect(mockShutdownPostHog).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true, "control", undefined])(
    "fails closed for unsupported assignment %p",
    async (assignment) => {
      mockEvaluateFlags.mockResolvedValue({ getFlag: () => assignment });

      const response = await GET(request);

      await expect(response.json()).resolves.toEqual({
        available: false,
        flagKey: "agent_auto_review_v1",
      });
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it("fails closed when authentication fails", async () => {
    mockGetUserIDAndPro.mockRejectedValue(new Error("unauthorized"));

    const response = await GET(request);

    await expect(response.json()).resolves.toEqual({
      available: false,
      flagKey: "agent_auto_review_v1",
    });
    expect(mockEvaluateFlags).not.toHaveBeenCalled();
  });
});
