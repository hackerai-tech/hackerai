import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isSameYear,
} from "date-fns";

export function formatMessageActionTimestamp(
  timestamp: number | undefined,
  now: Date = new Date(),
): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (isSameDay(date, now)) {
    return format(date, "h:mm a");
  }

  const daysAgo = differenceInCalendarDays(now, date);
  if (daysAgo >= 1 && daysAgo <= 7) {
    return format(date, "EEEE h:mm a");
  }

  return isSameYear(date, now)
    ? format(date, "MMM d h:mm a")
    : format(date, "MMM d, yyyy h:mm a");
}
