import {
  describeTiming,
  nextScheduledTime,
  validateSchedule,
  type ScheduleTiming,
} from "../recurrence";
const at = (s: string) => Date.parse(s);
const weekly = (
  time: string,
  weekdays = [0, 1, 2, 3, 4, 5, 6],
  timezone = "America/Chicago",
): ScheduleTiming => ({ type: "weekly", time, weekdays, timezone });
describe("schedule recurrence", () => {
  it("respects a weekday and explicit time zone", () => {
    expect(
      nextScheduledTime(weekly("09:00", [1]), at("2026-11-06T12:00:00Z")),
    ).toBe(at("2026-11-09T15:00:00Z"));
  });
  it("uses the new offset across daylight saving changes", () => {
    expect(nextScheduledTime(weekly("09:00"), at("2026-03-07T16:00:00Z"))).toBe(
      at("2026-03-08T14:00:00Z"),
    );
  });
  it("skips a spring-forward time that does not exist", () => {
    expect(nextScheduledTime(weekly("02:30"), at("2026-03-08T06:00:00Z"))).toBe(
      at("2026-03-09T07:30:00Z"),
    );
  });
  it("does not fire twice during the repeated fall-back hour", () => {
    expect(nextScheduledTime(weekly("01:30"), at("2026-11-01T05:00:00Z"))).toBe(
      at("2026-11-01T06:30:00Z"),
    );
    expect(nextScheduledTime(weekly("01:30"), at("2026-11-01T06:30:00Z"))).toBe(
      at("2026-11-02T07:30:00Z"),
    );
  });
  it("handles half-hour zones and midnight", () => {
    expect(
      nextScheduledTime(
        weekly("00:00", [0, 1, 2, 3, 4, 5, 6], "Asia/Kolkata"),
        at("2026-11-07T13:00:00Z"),
      ),
    ).toBe(at("2026-11-07T18:30:00Z"));
  });
  it("handles the date line independently of the server zone", () => {
    expect(
      nextScheduledTime(
        weekly("09:00", [1], "Pacific/Auckland"),
        at("2026-11-07T13:00:00Z"),
      ),
    ).toBe(at("2026-11-08T20:00:00Z"));
  });
  it("skips missed intervals without replaying a backlog", () => {
    expect(
      nextScheduledTime(
        { type: "interval", minutes: 60 },
        at("2026-11-07T13:17:00Z"),
      ),
    ).toBe(at("2026-11-07T14:17:00Z"));
  });
  it("consumes a one-time schedule", () => {
    expect(nextScheduledTime({ type: "once", at: 1000 }, 1000)).toBeNull();
    expect(nextScheduledTime({ type: "once", at: 1000 }, 999)).toBe(1000);
  });
  it.each([
    { type: "interval", minutes: 1 },
    { type: "interval", minutes: 15.5 },
    { type: "interval", minutes: Infinity },
    { type: "weekly", time: "25:00", weekdays: [1], timezone: "UTC" },
    { type: "weekly", time: "09:00", weekdays: [], timezone: "UTC" },
    { type: "weekly", time: "09:00", weekdays: [7], timezone: "UTC" },
    { type: "weekly", time: "09:00", weekdays: [1], timezone: "fake/zone" },
    { type: "once", at: NaN },
  ])("rejects invalid timing %p", (timing) => {
    expect(() =>
      validateSchedule({
        name: "test",
        prompt: "hello",
        model: "default",
        timing,
      }),
    ).toThrow();
  });
  it("normalizes names and strips unknown authority fields", () => {
    const result = validateSchedule({
      name: " test ",
      prompt: " hello ",
      model: "pro",
      userId: "other",
      sandboxPreference: "local",
      timing: {
        type: "weekly",
        time: "09:00",
        weekdays: [3, 1, 3],
        timezone: "UTC",
      },
    });
    expect(result).toEqual({
      name: "test",
      prompt: "hello",
      model: "pro",
      timing: {
        type: "weekly",
        time: "09:00",
        weekdays: [1, 3],
        timezone: "UTC",
      },
    });
  });
  it("uses readable recurrence labels", () => {
    expect(describeTiming(weekly("09:00", [1, 2, 3, 4, 5]))).toBe(
      "Weekdays at 09:00",
    );
    expect(describeTiming({ type: "interval", minutes: 60 })).toBe(
      "Every 1 hour",
    );
  });
});
