import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isSameYear,
} from "date-fns";
import { formatMessageActionTimestamp } from "../message-time";

jest.mock("date-fns", () => {
  const actual = jest.requireActual<typeof import("date-fns")>("date-fns");
  return {
    ...actual,
    differenceInCalendarDays: jest.fn(actual.differenceInCalendarDays),
    format: jest.fn(actual.format),
    isSameDay: jest.fn(actual.isSameDay),
    isSameYear: jest.fn(actual.isSameYear),
  };
});

beforeEach(() => {
  const actual = jest.requireActual<typeof import("date-fns")>("date-fns");
  jest
    .mocked(differenceInCalendarDays)
    .mockReset()
    .mockImplementation(actual.differenceInCalendarDays);
  jest.mocked(format).mockReset().mockImplementation(actual.format);
  jest.mocked(isSameDay).mockReset().mockImplementation(actual.isSameDay);
  jest.mocked(isSameYear).mockReset().mockImplementation(actual.isSameYear);
});

describe("formatMessageActionTimestamp", () => {
  it("shows only the time for messages from the same day", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 29, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe("8:36 AM");
  });

  it("shows weekday and time for messages from the previous 7 days", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 28, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe(
      "Thursday 8:36 AM",
    );
  });

  it("still shows weekday and time for messages 7 days ago", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 22, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe("Friday 8:36 AM");
  });

  it("shows date and time for messages more than 7 days ago", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 20, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe("May 20 8:36 AM");
  });

  it("includes the year for messages from another year", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2025, 11, 31, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe(
      "Dec 31, 2025 8:36 AM",
    );
  });

  it("returns null for missing or invalid timestamps", () => {
    expect(formatMessageActionTimestamp(undefined)).toBeNull();
    expect(formatMessageActionTimestamp(Number.NaN)).toBeNull();
  });

  it.each([
    ["day_compare", 29, isSameDay],
    ["format_time", 29, format],
    ["days_diff", 28, differenceInCalendarDays],
    ["format_weekday", 28, format],
    ["year_compare", 20, isSameYear],
    ["format_date", 20, format],
  ] as const)(
    "observes the actual %s failure and rethrows the original value",
    (phase, day, operation) => {
      const original = Object.freeze(new Error("PRIVATE_ERROR_CANARY"));
      jest.mocked(operation).mockImplementationOnce(() => {
        throw original;
      });
      const observed = jest.fn();
      let caught: unknown;
      try {
        formatMessageActionTimestamp(
          new Date(2026, 4, day).getTime(),
          new Date(2026, 4, 29),
          observed,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(original);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(phase);
      expect(JSON.stringify(observed.mock.calls)).not.toContain(
        "PRIVATE_ERROR_CANARY",
      );
    },
  );

  it("preserves the exact original error when optional diagnostics throw", () => {
    const original = Object.freeze(new Error("original"));
    jest.mocked(isSameDay).mockImplementationOnce(() => {
      throw original;
    });
    let caught: unknown;
    try {
      formatMessageActionTimestamp(Date.now(), undefined, () => {
        throw new Error("diagnostic failure");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
  });
});
