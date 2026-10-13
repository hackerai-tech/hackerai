import {
  observeBrowserResponsiveness,
  sampleBrowserPerformance,
} from "../useBrowserResponsiveness";
import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "@/lib/analytics/client";

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
}));

describe("browser responsiveness summaries", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = "";
  });

  it("aggregates typing and scrolling without recording entered content", async () => {
    const stop = observeBrowserResponsiveness("user");
    const textarea = document.createElement("textarea");
    textarea.value = "private target and prompt";
    document.body.append(textarea);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    document.dispatchEvent(new Event("scroll"));
    await jest.advanceTimersByTimeAsync(1000);
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
    stop();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "chat_browser_responsiveness",
      expect.objectContaining({
        input_count: 1,
        scroll_count: 1,
        input_frame_delay_max_ms: expect.any(Number),
        scroll_frame_gap_max_ms: expect.any(Number),
      }),
    );
    expect(
      JSON.stringify(jest.mocked(captureAuthenticatedEvent).mock.calls),
    ).not.toContain(textarea.value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(captureAuthenticatedEvent).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("drops pending measurements when consent is revoked", () => {
    const stop = observeBrowserResponsiveness("user");
    document.dispatchEvent(new Event("scroll"));
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(null);
    stop();
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("labels Event Timing entries accurately when an interaction emits multiple entries", () => {
    const original = global.PerformanceObserver;
    let callback!: PerformanceObserverCallback;
    const disconnect = jest.fn();
    global.PerformanceObserver = class {
      static supportedEntryTypes = ["event"];
      constructor(onEntries: PerformanceObserverCallback) {
        callback = onEntries;
      }
      observe() {}
      disconnect = disconnect;
    } as unknown as typeof PerformanceObserver;
    try {
      const stop = observeBrowserResponsiveness("user");
      callback(
        {
          getEntries: () => [
            { startTime: performance.now(), duration: 32, interactionId: 7 },
            { startTime: performance.now(), duration: 48, interactionId: 7 },
          ],
        } as unknown as PerformanceObserverEntryList,
        {} as PerformanceObserver,
      );
      stop();
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "chat_browser_responsiveness",
        expect.objectContaining({
          event_timing_entry_count: 2,
          event_timing_duration_max_ms: 48,
        }),
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      global.PerformanceObserver = original;
    }
  });

  it("uses stable user sampling", () => {
    const selected = Array.from({ length: 1000 }, (_, i) => `user-${i}`).filter(
      sampleBrowserPerformance,
    );
    expect(selected.length).toBeGreaterThan(80);
    expect(selected.length).toBeLessThan(120);
    expect(selected.every(sampleBrowserPerformance)).toBe(true);
  });
});
