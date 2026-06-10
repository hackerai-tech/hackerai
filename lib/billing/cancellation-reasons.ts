export const CANCELLATION_REASON_DETAILS_MAX_LENGTH = 2_000;

export const CANCELLATION_REASON_OPTIONS = [
  { value: "too_expensive", label: "Too expensive" },
  { value: "not_using_enough", label: "Not using it enough" },
  { value: "missing_feature", label: "Missing feature" },
  { value: "results_not_good_enough", label: "Results were not good enough" },
  { value: "too_slow_or_unreliable", label: "Too slow or unreliable" },
  { value: "hit_usage_limits", label: "Hit usage limits too often" },
  { value: "switched_tool", label: "Switched to another tool" },
  { value: "temporary_pause", label: "Temporary pause / will return later" },
  { value: "other", label: "Other" },
] as const;

export type CancellationReasonCategory =
  (typeof CANCELLATION_REASON_OPTIONS)[number]["value"];

const CANCELLATION_REASON_VALUES = new Set<string>(
  CANCELLATION_REASON_OPTIONS.map((option) => option.value),
);

export function isCancellationReasonCategory(
  value: unknown,
): value is CancellationReasonCategory {
  return typeof value === "string" && CANCELLATION_REASON_VALUES.has(value);
}

export function normalizeCancellationReasonDetails(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed.slice(0, CANCELLATION_REASON_DETAILS_MAX_LENGTH);
}
