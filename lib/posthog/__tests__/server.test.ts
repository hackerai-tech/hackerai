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
