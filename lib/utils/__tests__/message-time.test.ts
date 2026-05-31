import { describe, expect, it } from "@jest/globals";
import { formatMessageActionTimestamp } from "../message-time";

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
});
