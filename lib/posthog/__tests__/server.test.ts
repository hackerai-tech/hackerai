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

  it("forwards event identity fields at the PostHog envelope level", () => {
    const timestamp = new Date("2026-07-17T16:30:45.123Z");

    phLogger.event(
      "checkout_started",
      {
        userId: "user_123",
        checkout_attempt_id: "ca_attempt_123",
      },
      {
        uuid: "a0f4f90b-0a46-52d8-87d2-9ef6792e2e56",
        timestamp,
      },
    );

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "checkout_started",
      properties: { checkout_attempt_id: "ca_attempt_123" },
      uuid: "a0f4f90b-0a46-52d8-87d2-9ef6792e2e56",
      timestamp,
    });
  });
});
