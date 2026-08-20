jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { error: jest.fn(), warn: jest.fn() },
}));

import { createRedisClient } from "@/lib/rate-limit/redis";
import { phLogger } from "@/lib/posthog/server";
import {
  recordGroupedSpikeAlert,
  resetGroupedSpikeAlertStateForTests,
} from "../grouped-spike-alert";

const mockRedis = {
  incr: jest.fn(),
  expire: jest.fn(),
  set: jest.fn(),
};
const mockCreateRedisClient = createRedisClient as jest.MockedFunction<
  typeof createRedisClient
>;
const mockPhLogger = phLogger as jest.Mocked<typeof phLogger>;

describe("recordGroupedSpikeAlert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGroupedSpikeAlertStateForTests();
    mockCreateRedisClient.mockReturnValue(mockRedis as never);
    mockRedis.expire.mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits one stable error only after the shared threshold is crossed", async () => {
    mockRedis.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6);
    mockRedis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    for (let attempt = 0; attempt < 6; attempt++) {
      await recordGroupedSpikeAlert({
        spikeKey: "sandbox_attachment_acquisition:placement_failure",
        sourceEvent: "sandbox_attachment_acquisition_retry_failed",
      });
    }

    expect(mockPhLogger.error).toHaveBeenCalledTimes(1);
    expect(mockPhLogger.error).toHaveBeenCalledWith(
      "Grouped operational error spike detected",
      expect.objectContaining({
        event: "grouped_operational_error_spike_detected",
        occurrence_count: 5,
        threshold: 5,
        window_ms: 300_000,
        cooldown_ms: 900_000,
      }),
    );
    expect(mockRedis.set).toHaveBeenCalledTimes(2);
  });

  it("does not let caller attributes override the grouped-event contract", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-20T14:38:41.000Z"));
    mockRedis.incr.mockResolvedValueOnce(1);
    mockRedis.set.mockResolvedValueOnce("OK");

    await recordGroupedSpikeAlert({
      spikeKey: "provider timeout / openai",
      sourceEvent: "provider_timeout",
      threshold: 1,
      windowMs: 60_000,
      cooldownMs: 120_000,
      attributes: {
        event: "caller_event",
        spike_key: "caller_spike_key",
        source_event: "caller_source_event",
        occurrence_count: 999,
        threshold: 999,
        window_ms: 999,
        cooldown_ms: 999,
        window_started_at: "caller_window",
        request_id: "request-123",
      },
    });

    expect(mockPhLogger.error).toHaveBeenCalledWith(
      "Grouped operational error spike detected",
      expect.objectContaining({
        event: "grouped_operational_error_spike_detected",
        spike_key: "provider_timeout___openai",
        source_event: "provider_timeout",
        occurrence_count: 1,
        threshold: 1,
        window_ms: 60_000,
        cooldown_ms: 120_000,
        window_started_at: "2026-08-20T14:38:00.000Z",
        request_id: "request-123",
      }),
    );
  });

  it("does nothing when the shared counter is not configured", async () => {
    mockCreateRedisClient.mockReturnValueOnce(null as never);

    await recordGroupedSpikeAlert({
      spikeKey: "sandbox_attachment_acquisition:placement_failure",
      sourceEvent: "sandbox_attachment_acquisition_retry_failed",
    });

    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockPhLogger.error).not.toHaveBeenCalled();
  });

  it("reports a counter outage at most once per worker", async () => {
    mockRedis.incr.mockRejectedValue(new Error("Redis unavailable"));

    await recordGroupedSpikeAlert({
      spikeKey: "sandbox_attachment_acquisition:placement_failure",
      sourceEvent: "sandbox_attachment_acquisition_retry_failed",
    });
    await recordGroupedSpikeAlert({
      spikeKey: "sandbox_attachment_acquisition:placement_failure",
      sourceEvent: "sandbox_attachment_acquisition_retry_failed",
    });

    expect(mockPhLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockPhLogger.error).not.toHaveBeenCalled();
  });
});
