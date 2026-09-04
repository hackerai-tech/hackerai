import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockConvexQuery = jest.fn();
const mockResumePausedSubscription = jest.fn();
const mockPostHogInfo = jest.fn();
const mockPostHogWarn = jest.fn();

jest.mock("next/server", () => ({
  after: jest.fn((callback: () => void) => callback()),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockConvexQuery }),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    subscriptionPauses: {
      listDueResumes: "subscriptionPauses.listDueResumes",
    },
  },
}));

jest.mock("@/lib/billing/pause-resume", () => ({
  resumePausedSubscription: mockResumePausedSubscription,
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    info: mockPostHogInfo,
    warn: mockPostHogWarn,
    error: jest.fn(),
    flush: jest.fn(),
  },
}));

function cronRequest(secret?: string) {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" && secret
          ? `Bearer ${secret}`
          : null,
    },
  } as unknown as Request;
}

describe("GET /api/cron/subscription-pauses", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalServiceKey === undefined) {
      delete process.env.CONVEX_SERVICE_ROLE_KEY;
    } else {
      process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
    }
  });

  it("rejects requests without the cron secret", async () => {
    const { GET } = await import("../route");

    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(mockConvexQuery).not.toHaveBeenCalled();
  });

  it("resumes every due pause and reports the outcome mix", async () => {
    mockConvexQuery.mockResolvedValue([
      { id: "pause_1" },
      { id: "pause_2" },
      { id: "pause_3" },
      { id: "pause_4" },
    ] as never);
    mockResumePausedSubscription
      .mockResolvedValueOnce({
        outcome: "resumed",
        stripeSubscriptionId: "sub_1",
      } as never)
      .mockResolvedValueOnce({
        outcome: "superseded",
        stripeSubscriptionId: "sub_2",
      } as never)
      .mockResolvedValueOnce({
        outcome: "failed",
        failureKind: "payment_failed",
        retryScheduled: true,
        message: "declined",
      } as never)
      .mockResolvedValueOnce({ outcome: "not_claimable" } as never);
    const { GET } = await import("../route");

    const response = await GET(cronRequest("cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      due: 4,
      resumed: 1,
      superseded: 1,
      failed: 1,
      retryScheduled: 1,
      skipped: 1,
    });
    expect(mockConvexQuery).toHaveBeenCalledWith(
      "subscriptionPauses.listDueResumes",
      expect.objectContaining({ serviceKey: "service-key", limit: 50 }),
    );
    expect(mockResumePausedSubscription).toHaveBeenCalledTimes(4);
    expect(mockResumePausedSubscription).toHaveBeenCalledWith(
      { id: "pause_1" },
      expect.objectContaining({ trigger: "cron" }),
    );
    expect(mockPostHogInfo).toHaveBeenCalledWith(
      "subscription_pause_cron_completed",
      expect.objectContaining({ resumed: 1, failed: 1 }),
    );
  });

  it("returns 500 when the due list cannot be loaded", async () => {
    mockConvexQuery.mockRejectedValue(new Error("convex down") as never);
    const { GET } = await import("../route");

    const response = await GET(cronRequest("cron-secret"));

    expect(response.status).toBe(500);
  });
});
