import { describe, expect, it, jest } from "@jest/globals";

const mockConstructEvent = jest.fn();
const mockMutation = jest.fn();
const mockCaptureUserEmailVerified = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));

jest.mock("@/lib/analytics/user-signup", () => ({
  captureUserEmailVerified: mockCaptureUserEmailVerified,
  captureUserSignedUp: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    flush: jest.fn(),
  },
}));

describe("POST /api/workos/webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutation.mockReset();
    process.env.WORKOS_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-service-role-key";
  });

  afterEach(() => jest.useRealTimers());

  it.each([
    ["recovers a reset", "ECONNRESET", 1, 2, "recovered"],
    ["bounds persistent resets", "ECONNRESET", 3, 3, "exhausted"],
    ["does not retry application failures", "FORBIDDEN", 1, 1, "not_retryable"],
  ])(
    "%s without repeating the event handler",
    async (_name, code, failures, attempts, outcome) => {
      jest.useFakeTimers();
      mockConstructEvent.mockResolvedValue({
        id: "event-retry",
        event: "authentication.email_verification_succeeded",
        createdAt: "2026-10-30T00:00:00Z",
        data: { userId: "user-test" },
      });
      mockMutation.mockResolvedValueOnce({ state: "acquired" });
      for (let i = 0; i < Number(failures); i++) {
        mockMutation.mockRejectedValueOnce(
          new TypeError("private error contents", {
            cause: Object.assign(new Error("private socket details"), { code }),
          }),
        );
      }
      mockMutation.mockResolvedValue(undefined);
      const { POST } = await import("../route");
      const pending = POST({
        headers: { get: () => "signature" },
        json: async () => ({}),
      } as any);
      await jest.runAllTimersAsync();
      expect((await pending).status).toBe(200);
      expect(mockMutation).toHaveBeenCalledTimes(1 + Number(attempts));
      expect(mockCaptureUserEmailVerified).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "WorkOS webhook finalization outcome",
        expect.objectContaining({
          event: "workos.webhook_finalization",
          attempts,
          outcome,
        }),
      );
      expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(
        "private",
      );
      expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(
        "test-service-role-key",
      );
    },
  );

  it("treats a missing signature as a warning-level client rejection", async () => {
    const { POST } = await import("../route");
    const request = {
      headers: {
        get: jest.fn((name: string) =>
          name === "x-vercel-id" ? "iad1::request-1" : null,
        ),
      },
    } as any;

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Missing workos-signature header" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected WorkOS webhook without a signature",
      expect.objectContaining({
        event: "workos.webhook_missing_signature",
        request_id: "iad1::request-1",
        service: "hackerai-web",
        route: "/api/workos/webhook",
      }),
    );
  });

  it("captures an email verification without forwarding WorkOS PII", async () => {
    mockConstructEvent.mockResolvedValue({
      id: "event-verified-1",
      event: "authentication.email_verification_succeeded",
      createdAt: "2026-08-07T12:05:00.000Z",
      data: {
        type: "email_verification",
        status: "succeeded",
        userId: "user-1",
        email: "private@example.com",
        ipAddress: "203.0.113.1",
        userAgent: "private-user-agent",
      },
    });
    mockMutation
      .mockResolvedValueOnce({ state: "acquired" })
      .mockResolvedValueOnce(undefined);

    const { POST } = await import("../route");
    const request = {
      headers: {
        get: jest.fn((name: string) =>
          name === "workos-signature" ? "signature" : null,
        ),
      },
      json: jest.fn(async () => ({ signed: "payload" })),
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockCaptureUserEmailVerified).toHaveBeenCalledWith({
      userId: "user-1",
      workosEventId: "event-verified-1",
      workosEventCreatedAt: "2026-08-07T12:05:00.000Z",
    });
    expect(mockCaptureUserEmailVerified.mock.calls[0]?.[0]).not.toHaveProperty(
      "email",
    );
    expect(mockCaptureUserEmailVerified.mock.calls[0]?.[0]).not.toHaveProperty(
      "ipAddress",
    );
    expect(mockCaptureUserEmailVerified.mock.calls[0]?.[0]).not.toHaveProperty(
      "userAgent",
    );
  });
});
