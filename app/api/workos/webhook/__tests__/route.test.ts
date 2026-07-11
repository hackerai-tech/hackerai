import { describe, expect, it, jest } from "@jest/globals";

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

describe("POST /api/workos/webhook", () => {
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
});
