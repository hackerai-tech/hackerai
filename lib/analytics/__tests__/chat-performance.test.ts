import { ChatPerformanceTracker } from "../chat-performance";
import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "../client";

jest.mock("../client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
}));

describe("visible chat timings", () => {
  let now = 0;
  beforeEach(() => {
    jest.clearAllMocks();
    now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("reports first rendered text and gaps without content", () => {
    const tracker = new ChatPerformanceTracker();
    tracker.start("chat", "agent", ["old"]);
    expect(tracker.accepts("old")).toBe(false);
    expect(tracker.accepts("new")).toBe(true);
    now = 8000;
    tracker.textPainted(tracker.id!);
    now = 14_000;
    tracker.textPainted(tracker.id!);
    tracker.setRunId("run");
    tracker.finish();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "chat_visible_response_performance",
      expect.objectContaining({
        first_visible_text_ms: 8000,
        max_visible_text_gap_ms: 6000,
        visible_text_gap_ge5s_count: 1,
        trigger_run_id: "run",
        outcome: "completed",
      }),
    );
    tracker.finish();
    expect(captureAuthenticatedEvent).toHaveBeenCalledTimes(1);
  });

  it("retains no-text outcomes and prevents stale frames crossing requests", () => {
    const tracker = new ChatPerformanceTracker();
    tracker.start("chat", "ask", []);
    const previous = tracker.id!;
    tracker.start("chat", "ask", []);
    tracker.textPainted(previous);
    tracker.setOutcome("aborted");
    tracker.finish();
    expect(captureAuthenticatedEvent).toHaveBeenLastCalledWith(
      "chat_visible_response_performance",
      expect.objectContaining({
        outcome: "aborted",
        first_visible_text_ms: null,
        visible_text_observed: false,
      }),
    );
  });

  it("does not count background time as a streaming gap", () => {
    const tracker = new ChatPerformanceTracker();
    tracker.start("chat", "ask", []);
    now = 1000;
    tracker.textPainted(tracker.id!);
    tracker.background();
    now = 100_000;
    tracker.textPainted(tracker.id!);
    tracker.finish();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "chat_visible_response_performance",
      expect.objectContaining({
        backgrounded: true,
        max_visible_text_gap_ms: 0,
        visible_text_gap_ge5s_count: 0,
      }),
    );
  });

  it("drops samples on consent withdrawal or identity change", () => {
    const tracker = new ChatPerformanceTracker();
    tracker.start("chat", "ask", []);
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(null);
    tracker.finish();
    tracker.start("chat", "ask", []);
    expect(tracker.id).toBeUndefined();
    expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
  });
});
