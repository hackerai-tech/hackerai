import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isSameYear,
} from "date-fns";

export const MESSAGE_TIMESTAMP_PHASES = [
  "day_compare",
  "format_time",
  "days_diff",
  "format_weekday",
  "year_compare",
  "format_date",
] as const;
export type MessageTimestampPhase = (typeof MESSAGE_TIMESTAMP_PHASES)[number];

export function formatMessageActionTimestamp(
  timestamp: number | undefined,
  now: Date = new Date(),
  onFailure?: (phase: MessageTimestampPhase) => void,
): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  let phase: MessageTimestampPhase = "day_compare";
  try {
    if (isSameDay(date, now)) {
      phase = "format_time";
      return format(date, "h:mm a");
    }

    phase = "days_diff";
    const daysAgo = differenceInCalendarDays(now, date);
    if (daysAgo >= 1 && daysAgo <= 7) {
      phase = "format_weekday";
      return format(date, "EEEE h:mm a");
    }

    phase = "year_compare";
    const sameYear = isSameYear(date, now);
    phase = "format_date";
    return format(date, sameYear ? "MMM d h:mm a" : "MMM d, yyyy h:mm a");
  } catch (error) {
    try {
      onFailure?.(phase);
    } catch {
      // Optional attribution cannot replace or suppress the original exception.
    }
    throw error;
  }
}
