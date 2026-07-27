jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
  },
}));

import { phLogger } from "@/lib/posthog/server";
import {
  createE2BCpuSaturationObserver,
  E2B_CPU_SATURATION_THRESHOLD_PCT,
} from "@/lib/analytics/sandbox-resource-pressure";

const mockPhEvent = phLogger.event as jest.MockedFunction<
  typeof phLogger.event
>;

describe("E2B CPU saturation telemetry", () => {
  beforeEach(() => {
    mockPhEvent.mockClear();
  });

  const createObserver = () =>
    createE2BCpuSaturationObserver({
      userId: "user-1",
      chatId: "chat-1",
      mode: "agent",
      subscription: "pro-plus",
    });

  test("emits a privacy-safe event when CPU enters saturation", () => {
    const observe = createObserver();

    observe({ cpuPct: 99.876, memPct: 72.345, diskPct: 41.234 });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_sandbox_cpu_saturation_observed",
      {
        userId: "user-1",
        chat_id: "chat-1",
        mode: "agent",
        subscription_tier: "pro-plus",
        sandbox_type: "e2b",
        cpu_used_pct: 99.88,
        memory_used_pct: 72.35,
        disk_used_pct: 41.23,
        cpu_saturation_threshold_pct: E2B_CPU_SATURATION_THRESHOLD_PCT,
        observation_source: "pre_command_health_check",
        cpu_saturation_event_version: 1,
      },
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("command");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("error");
  });

  test("does not emit below the saturation threshold", () => {
    const observe = createObserver();

    observe({
      cpuPct: E2B_CPU_SATURATION_THRESHOLD_PCT - 0.01,
      memPct: 80,
      diskPct: 50,
    });

    expect(mockPhEvent).not.toHaveBeenCalled();
  });

  test("deduplicates one sustained episode and rearms after recovery", () => {
    const observe = createObserver();

    observe({ cpuPct: 100, memPct: 70, diskPct: 40 });
    observe({ cpuPct: 100, memPct: 71, diskPct: 40 });
    observe({ cpuPct: 80, memPct: 71, diskPct: 40 });
    observe({ cpuPct: 99, memPct: 72, diskPct: 40 });

    expect(mockPhEvent).toHaveBeenCalledTimes(2);
  });
});
