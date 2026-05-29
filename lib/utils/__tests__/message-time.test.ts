import { describe, expect, it } from "@jest/globals";
import { formatMessageActionTimestamp } from "../message-time";

describe("formatMessageActionTimestamp", () => {
  it("shows only the time for messages from the same day", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 29, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe("8:36 AM");
  });

  it("shows weekday and time for messages from yesterday or earlier", () => {
    const now = new Date(2026, 4, 29, 15, 0);
    const timestamp = new Date(2026, 4, 28, 8, 36).getTime();

    expect(formatMessageActionTimestamp(timestamp, now)).toBe(
      "Thursday 8:36 AM",
    );
  });

  it("returns null for missing or invalid timestamps", () => {
    expect(formatMessageActionTimestamp(undefined)).toBeNull();
    expect(formatMessageActionTimestamp(Number.NaN)).toBeNull();
  });
});
