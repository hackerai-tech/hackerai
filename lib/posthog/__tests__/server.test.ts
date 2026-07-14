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

  it("continues sending errors to exception tracking", () => {
    phLogger.error("provider_failed", {
      userId: "user_123",
      error: new Error("provider failed"),
      requestId: "req_123",
    });

    expect(mockEmitPostHogLog).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
