import { DesktopRelayTelemetry } from "../desktop-relay";

describe("desktop relay telemetry", () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date("2026-09-22T00:00:00Z")),
  );
  afterEach(() => jest.useRealTimers());

  it("preserves first errors and recovery while counting repeated callbacks exactly", () => {
    const capture = jest.fn();
    const telemetry = new DesktopRelayTelemetry(capture);
    for (let i = 0; i < 100; i++) {
      telemetry.record("desktop_bridge_relay_error", {
        state: "error",
        errorType: "transport",
        code: 2,
        reconnectAttempt: i,
      });
    }
    expect(capture).toHaveBeenCalledTimes(1);
    telemetry.record("desktop_bridge_relay_state_changed", {
      state: "connected",
      source: "subscription",
      recovered: true,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][1]).toMatchObject({
      state: "connected",
      recovered: true,
    });
    telemetry.flush();
    const errors = capture.mock.calls.filter(
      ([event]) => event === "desktop_bridge_relay_error",
    );
    expect(errors).toHaveLength(2);
    expect(
      errors.reduce(
        (total, [, props]) => total + props.telemetry_occurrences,
        0,
      ),
    ).toBe(100);
    expect(errors[1][1]).toMatchObject({
      telemetry_summary: true,
      reconnectAttempt: 99,
    });
    telemetry.flush();
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("keeps new error signatures and resumes first-event capture in the next window", () => {
    const capture = jest.fn();
    const telemetry = new DesktopRelayTelemetry(capture);
    const error = { state: "error", errorType: "transport", code: 2 };
    telemetry.record("desktop_bridge_relay_error", error);
    telemetry.record("desktop_bridge_relay_error", error);
    telemetry.record("desktop_bridge_relay_error", { ...error, code: 109 });
    expect(capture).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(5 * 60 * 1000);
    telemetry.record("desktop_bridge_relay_error", error);
    expect(capture).toHaveBeenCalledTimes(4);
    expect(capture.mock.calls[2][1]).toMatchObject({
      telemetry_occurrences: 1,
      telemetry_summary: true,
    });
    expect(capture.mock.calls[3][1]).toMatchObject({
      telemetry_occurrences: 1,
      telemetry_summary: false,
    });
  });
});
