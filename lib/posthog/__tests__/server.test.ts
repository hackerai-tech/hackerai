import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCapture = jest.fn();
const mockCaptureException = jest.fn();
const mockPostHogClient = jest.fn(() => ({
  capture: mockCapture,
  captureException: mockCaptureException,
}));
const mockEmitPostHogLog = jest.fn(() => true);

jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: mockPostHogClient,
}));

jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: mockEmitPostHogLog,
  flushPostHogLogs: jest.fn(),
}));

const { phLogger } = require("../server") as typeof import("../server");

describe("phLogger", () => {
  beforeEach(() => {
    mockCapture.mockClear();
    mockCaptureException.mockClear();
    mockPostHogClient.mockClear();
    mockEmitPostHogLog.mockClear();
  });

  it("keeps info and warning records in Logs without duplicating product events", () => {
    phLogger.info("request_finished", { requestId: "req_123" });
    phLogger.warn("retry_scheduled", { requestId: "req_123" });

    expect(mockEmitPostHogLog).toHaveBeenCalledTimes(2);
    expect(mockPostHogClient).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("falls back to the console when a structured warning cannot be emitted", () => {
    const consoleWarn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockEmitPostHogLog.mockReturnValueOnce(false);

    phLogger.warn("retry_scheduled", { requestId: "req_123" });

    expect(consoleWarn).toHaveBeenCalledWith("retry_scheduled", {
      requestId: "req_123",
    });
    expect(mockPostHogClient).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it("continues sending errors to exception tracking", () => {
    phLogger.error("provider_failed", {
      userId: "user_123",
      error: new Error("provider failed"),
      requestId: "req_123",
    });

    expect(mockEmitPostHogLog).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("redacts signed URLs and raw causes before exception capture", () => {
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    const error = Object.assign(
      new Error(`Provider could not fetch ${signedUrl}`),
      {
        cause: new Error(`Upstream rejected ${signedUrl}`),
      },
    );

    phLogger.error(`provider_failed ${signedUrl}`, {
      userId: "user_123",
      error,
      requestId: "req_123",
      message: signedUrl,
    });

    const capturedError = mockCaptureException.mock.calls[0]?.[0] as Error;
    const capturedProperties = mockCaptureException.mock.calls[0]?.[2];
    const emittedLog = mockEmitPostHogLog.mock.calls[0]?.[0];
    const serialized = JSON.stringify({
      message: capturedError.message,
      stack: capturedError.stack,
      properties: capturedProperties,
      log: emittedLog,
    });

    expect(capturedError).toBeInstanceOf(Error);
    expect(serialized).toContain("[Redacted signed URL]");
    expect(serialized).not.toContain("user-files");
    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("signature-secret");
    expect("cause" in capturedError).toBe(false);
    expect(emittedLog?.body).toBe("provider_failed [Redacted signed URL]");
    expect(capturedProperties?.message).toBe(
      "provider_failed [Redacted signed URL]",
    );
  });

  it("redacts signed URLs from error console fallbacks", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error(`Telemetry failed for ${signedUrl}`);
    });

    try {
      phLogger.error(`provider_failed ${signedUrl}`, {
        error: new Error(`Provider failed for ${signedUrl}`),
        message: signedUrl,
      });

      const serialized = JSON.stringify(consoleError.mock.calls);

      expect(serialized).toContain("[Redacted signed URL]");
      expect(serialized).not.toContain("user-files");
      expect(serialized).not.toContain("access-key");
      expect(serialized).not.toContain("signature-secret");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("passes stable event UUIDs to PostHog without leaking them into properties", () => {
    phLogger.event("checkout_started", {
      userId: "user_123",
      eventUuid: "b01882bb-b996-52d2-aaca-b2f4edc0fa3d",
      checkout_attempt_id: "ca_12345678",
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "checkout_started",
      uuid: "b01882bb-b996-52d2-aaca-b2f4edc0fa3d",
      properties: {
        checkout_attempt_id: "ca_12345678",
      },
    });
  });
});
