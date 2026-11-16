/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import { GET } from "../route";

const mockGetUserIDAndPro = jest.fn();
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));

const mockGetFeatureFlagResult = jest.fn();
const mockCapture = jest.fn();
const errorListeners = new Set<(error: unknown) => void>();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlagResult: mockGetFeatureFlagResult,
    capture: mockCapture,
    on: (event: string, listener: (error: unknown) => void) => {
      if (event !== "error") return () => {};
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    shutdown: jest.fn(async () => undefined),
  }),
}));

const stored = new Map<string, number>();
const mockScard = jest.fn(async (key: string) => stored.get(key) ?? 0);
// First-assignment marker get-or-set (telemetry only).
const markers = new Map<string, number>();
const mockEval = jest.fn(
  async (_script: string, [key]: string[], [now]: string[]) => {
    if (!markers.has(key)) markers.set(key, Number(now));
    return markers.get(key);
  },
);
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ scard: mockScard, eval: mockEval }),
}));

const SUBJECT = "free_quota:v2:private-subject";
const CUTOFF = "2026-11-15T00:00:00.000Z";
const eligibleIdentity = {
  userId: "user_private",
  subscription: "free",
  emailVerified: true,
  accountCreatedAt: "2026-11-15T09:00:00.000Z",
  freeUsageQuotaSubject: SUBJECT,
};

const request = () =>
  new NextRequest(
    "https://app.example.test/api/experiments/free-agent-activation",
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        "x-vercel-ip-country": "US",
      },
    },
  );

describe("GET /api/experiments/free-agent-activation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stored.clear();
    markers.clear();
    errorListeners.clear();
    stored.set(`free_agent_activation:v1:${SUBJECT}`, 3);
    mockGetUserIDAndPro.mockResolvedValue(eligibleIdentity);
    mockGetFeatureFlagResult.mockResolvedValue({
      key: "free_agent_activation_gate_v1",
      enabled: true,
      variant: "test",
      payload: { new_users_from: CUTOFF },
    });
  });

  it("returns only the client-safe status, uncached", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: {
        variant: "test",
        completedAskResponses: 3,
        introLimit: 3,
        requiresAgent: true,
      },
    });
    for (const secret of ["user_private", SUBJECT, CUTOFF, "free_quota"]) {
      expect(text).not.toContain(secret);
    }
    // Server assignment is recorded for the denominator; lookup is not exposure.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user_private",
        event: "free_agent_activation_assigned",
      }),
    );
  });

  it.each([
    ["an upgraded account", { ...eligibleIdentity, subscription: "pro" }],
    [
      "an account created before the cutoff",
      {
        ...eligibleIdentity,
        accountCreatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  ])("returns null for %s", async (_, identity) => {
    mockGetUserIDAndPro.mockResolvedValue(identity);
    const response = await GET(request());
    await expect(response.json()).resolves.toEqual({ status: null });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("returns null under the kill switch without touching stored progress", async () => {
    mockGetFeatureFlagResult.mockResolvedValue({
      key: "free_agent_activation_gate_v1",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    const response = await GET(request());
    await expect(response.json()).resolves.toEqual({ status: null });
    expect(stored.get(`free_agent_activation:v1:${SUBJECT}`)).toBe(3);
  });

  it.each<[string, () => void]>([
    [
      "the flag service request fails",
      () =>
        mockGetFeatureFlagResult.mockImplementation(async () => {
          for (const listener of errorListeners) listener(new Error("network"));
          return undefined;
        }),
    ],
    [
      "the flag lookup rejects",
      () => mockGetFeatureFlagResult.mockRejectedValue(new Error("network")),
    ],
    [
      "the stored count cannot be read",
      () => mockScard.mockRejectedValueOnce(new Error("redis down")),
    ],
  ])(
    "returns an uncached 503 (unknown, not unenrolled) when %s",
    async (_, arrange) => {
      jest.spyOn(console, "warn").mockImplementation(() => {});
      arrange();
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ status: null });
    },
  );

  it("recovers from an unknown status to the gated status once storage answers", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockScard.mockRejectedValueOnce(new Error("redis down"));
    expect((await GET(request())).status).toBe(503);

    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: expect.objectContaining({ requiresAgent: true }),
    });
  });

  it("requires authentication", async () => {
    mockGetUserIDAndPro.mockRejectedValue(
      new ChatSDKError("unauthorized:auth"),
    );
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
  });

  it("returns an uncached null status on an unexpected failure", async () => {
    mockGetUserIDAndPro.mockRejectedValue(new Error("boom"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: null });
  });
});
