import { describe, expect, it, jest } from "@jest/globals";

const mockConstructEvent = jest.fn();
const mockMutation = jest.fn();
const mockCaptureUserEmailVerified = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

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
    error: mockLoggerError,
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
    mockLoggerError.mockReset();
    mockConstructEvent.mockReset();
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

  it("joins a failed verified claim without replaying the claim or handler", async () => {
    const eventId = "event_01HDF4BKFX4QW1FJ7N3P9R2M6A";
    const requestId = "tgb7w-1794258226246-c08ea5aec887";
    const error = new TypeError("fetch failed");
    mockConstructEvent.mockResolvedValue({
      id: eventId,
      event: "authentication.email_verification_succeeded",
      data: { userId: "private-user", email: "private@example.com" },
    });
    mockMutation.mockRejectedValue(error);
    const { POST } = await import("../route");
    const response = await POST({
      headers: {
        get: (name: string) =>
          name === "x-vercel-id" ? requestId : "private-signature",
      },
      json: async () => ({ secret: "private-payload" }),
    } as any);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to claim webhook" });
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockCaptureUserEmailVerified).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[WorkOS Webhook] Claim failed:",
      error,
      {
        event: "workos.webhook_claim_failed",
        workos_claim_diagnostic_version: 1,
        failure_stage: "claim",
        workos_event_id: eventId,
        workos_event_type: "authentication.email_verification_succeeded",
        request_id: requestId,
        service: "hackerai-web",
        route: "/api/workos/webhook",
      },
    );
    expect(JSON.stringify(mockLoggerError.mock.calls[0]?.[2])).not.toMatch(
      /private|secret|signature|payload|service-role/,
    );
  });

  it("omits unrecognized IDs and maps unknown event types without exposing payloads", async () => {
    mockConstructEvent.mockResolvedValue({
      id: "event_private@example.com",
      event: "private-event-type",
      data: { secret: "private-payload" },
    });
    mockMutation.mockRejectedValue(new Error("fetch failed"));
    const { POST } = await import("../route");
    const response = await POST({
      headers: { get: () => "private-header" },
      json: async () => ({}),
    } as any);
    expect(response.status).toBe(500);
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0]?.[2]).toEqual({
      event: "workos.webhook_claim_failed",
      workos_claim_diagnostic_version: 1,
      failure_stage: "claim",
      workos_event_type: "other",
      service: "hackerai-web",
      route: "/api/workos/webhook",
    });
  });

  it.each(["logger", "metadata"])(
    "preserves the original 500 if optional %s observation throws",
    async (failure) => {
      const verifiedEvent = {
        id: "event_01HDF4BKFX4QW1FJ7N3P9R2M6A",
        event: "user.created",
      };
      mockConstructEvent.mockResolvedValue(
        failure === "metadata"
          ? new Proxy(verifiedEvent, {
              getOwnPropertyDescriptor() {
                throw new Error("unreadable metadata");
              },
            })
          : verifiedEvent,
      );
      if (failure === "logger")
        mockLoggerError.mockImplementation(() => {
          throw new Error("logger unavailable");
        });
      mockMutation.mockRejectedValue(new Error("fetch failed"));
      const { POST } = await import("../route");
      const response = await POST({
        headers: { get: () => "signature" },
        json: async () => ({}),
      } as any);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to claim webhook",
      });
      expect(mockMutation).toHaveBeenCalledTimes(1);
      expect(mockCaptureUserEmailVerified).not.toHaveBeenCalled();
    },
  );

  it.each(["already_processed", "claim_held"])(
    "preserves %s acknowledgement without a claim-failure audit",
    async (state) => {
      mockConstructEvent.mockResolvedValue({
        id: "event-held",
        event: "authentication.email_verification_succeeded",
        data: { userId: "user-test" },
      });
      mockMutation.mockResolvedValue({ state });
      const { POST } = await import("../route");
      const response = await POST({
        headers: { get: () => "signature" },
        json: async () => ({}),
      } as any);
      expect(response.status).toBe(200);
      expect(mockMutation).toHaveBeenCalledTimes(1);
      expect(mockCaptureUserEmailVerified).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
    },
  );

  it("does not claim or emit verified-event context for a rejected signature", async () => {
    mockConstructEvent.mockRejectedValue(new Error("signature rejected"));
    const { POST } = await import("../route");
    const response = await POST({
      headers: { get: () => "signature" },
      json: async () => ({}),
    } as any);
    expect(response.status).toBe(400);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

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
