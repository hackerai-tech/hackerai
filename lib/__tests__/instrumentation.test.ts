jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("@/lib/posthog/logs", () => ({
  registerPostHogLogProvider: jest.fn(),
}));

jest.mock("@/lib/auth/expected-auth-errors", () => ({
  isEndedSessionRefreshError: jest.fn(() => false),
}));

import { phLogger } from "@/lib/posthog/server";
import { onRequestError } from "@/instrumentation";

describe("onRequestError", () => {
  const mockPhLoggerError = phLogger.error as jest.MockedFunction<
    typeof phLogger.error
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("adds bounded Server Action request metadata without sensitive headers", () => {
    const error = Object.assign(
      new SyntaxError("Unexpected end of JSON input"),
      {
        digest: "2147368089",
      },
    );

    onRequestError(
      error,
      {
        path: "/c/opaque-chat-id",
        method: "POST",
        headers: {
          "next-action": "a".repeat(40),
          "content-type": "text/plain; charset=utf-8",
          "content-length": "0",
          "x-vercel-id": "iad1::opaque-request",
          authorization: "Bearer secret",
          cookie: "session=secret",
        },
      },
      {
        routePath: "/c/[id]",
        routeType: "action",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    expect(mockPhLoggerError).toHaveBeenCalledWith(
      "Next.js request error",
      expect.objectContaining({
        error,
        routeType: "action",
        action_id: "a".repeat(40),
        content_type: "text/plain",
        content_length: 0,
        vercel_request_id: "iad1::opaque-request",
        error_digest: "2147368089",
      }),
    );
    const logged = JSON.stringify(mockPhLoggerError.mock.calls[0][1]);
    expect(logged).not.toContain("Bearer secret");
    expect(logged).not.toContain("session=secret");
  });

  it("omits malformed Server Action metadata", () => {
    onRequestError(
      new Error("boom"),
      {
        path: "/api/chat",
        method: "POST",
        headers: {
          "next-action": "not-an-action-id",
          "content-length": "NaN",
          "x-vercel-id": "not valid whitespace",
        },
      },
      {
        routePath: "/c/[id]",
        routeType: "action",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    const payload = mockPhLoggerError.mock.calls[0][1];
    expect(payload).not.toHaveProperty("action_id");
    expect(payload).not.toHaveProperty("content_length");
    expect(payload).not.toHaveProperty("vercel_request_id");
    expect(payload).not.toHaveProperty("error_digest");
  });

  it("leaves non-action request logging unchanged", () => {
    onRequestError(
      new Error("boom"),
      {
        path: "/api/chat",
        method: "POST",
        headers: {
          "next-action": "a".repeat(40),
          "content-length": "123",
          "x-vercel-id": "iad1::opaque-request",
        },
      },
      {
        routePath: "/api/chat",
        routeType: "route",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    const payload = mockPhLoggerError.mock.calls[0][1];
    expect(payload).not.toHaveProperty("action_id");
    expect(payload).not.toHaveProperty("content_length");
    expect(payload).not.toHaveProperty("vercel_request_id");
    expect(payload).not.toHaveProperty("error_digest");
  });
});
