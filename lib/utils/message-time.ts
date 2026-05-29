import { format, isSameDay } from "date-fns";

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

  return isSameDay(date, now)
    ? format(date, "h:mm a")
    : format(date, "EEEE h:mm a");
}
