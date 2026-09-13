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

export const CANCELLATION_REASON_SUBCATEGORY_OPTIONS = [
  {
    value: "too_expensive_low_frequency",
    label: "Too expensive for how often I use it",
  },
  {
    value: "insufficient_included_usage",
    label: "The plan doesn't include enough usage",
  },
  {
    value: "failed_or_incomplete_task",
    label: "A task failed or didn't finish",
  },
  {
    value: "slow_or_disconnected_agent",
    label: "Agent was slow or disconnected",
  },
  {
    value: "wrong_execution_environment",
    label: "Agent used the wrong execution environment",
  },
  {
    value: "model_quality",
    label: "The model's answers weren't good enough",
  },
  {
    value: "billing_or_renewal",
    label: "A billing or renewal issue",
  },
  {
    value: "missing_capability",
    label: "A capability I need is missing",
  },
  { value: "other", label: "Something else" },
] as const;

export type CancellationReasonSubcategory =
  (typeof CANCELLATION_REASON_SUBCATEGORY_OPTIONS)[number]["value"];

const SUBCATEGORY_VALUES_BY_CATEGORY = {
  too_expensive: [
    "too_expensive_low_frequency",
    "insufficient_included_usage",
    "billing_or_renewal",
    "other",
  ],
  not_using_enough: ["too_expensive_low_frequency", "other"],
  missing_feature: [
    "missing_capability",
    "wrong_execution_environment",
    "other",
  ],
  results_not_good_enough: [
    "failed_or_incomplete_task",
    "model_quality",
    "wrong_execution_environment",
    "other",
  ],
  too_slow_or_unreliable: [
    "slow_or_disconnected_agent",
    "failed_or_incomplete_task",
    "wrong_execution_environment",
    "other",
  ],
  hit_usage_limits: ["insufficient_included_usage", "other"],
  switched_tool: ["missing_capability", "model_quality", "other"],
  temporary_pause: ["too_expensive_low_frequency", "other"],
  other: [
    "billing_or_renewal",
    "missing_capability",
    "failed_or_incomplete_task",
    "slow_or_disconnected_agent",
    "wrong_execution_environment",
    "model_quality",
    "insufficient_included_usage",
    "too_expensive_low_frequency",
    "other",
  ],
} as const satisfies Record<
  CancellationReasonCategory,
  readonly CancellationReasonSubcategory[]
>;

const CANCELLATION_REASON_VALUES = new Set<string>(
  CANCELLATION_REASON_OPTIONS.map((option) => option.value),
);

const CANCELLATION_REASON_SUBCATEGORY_VALUES = new Set<string>(
  CANCELLATION_REASON_SUBCATEGORY_OPTIONS.map((option) => option.value),
);

const CANCELLATION_REASON_SUBCATEGORY_OPTION_BY_VALUE = new Map(
  CANCELLATION_REASON_SUBCATEGORY_OPTIONS.map((option) => [
    option.value,
    option,
  ]),
);

export function isCancellationReasonCategory(
  value: unknown,
): value is CancellationReasonCategory {
  return typeof value === "string" && CANCELLATION_REASON_VALUES.has(value);
}

export function isCancellationReasonSubcategory(
  value: unknown,
): value is CancellationReasonSubcategory {
  return (
    typeof value === "string" &&
    CANCELLATION_REASON_SUBCATEGORY_VALUES.has(value)
  );
}

export function isCancellationReasonSubcategoryForCategory(
  category: CancellationReasonCategory,
  subcategory: CancellationReasonSubcategory,
): boolean {
  return SUBCATEGORY_VALUES_BY_CATEGORY[category].some(
    (value) => value === subcategory,
  );
}

export function getCancellationReasonSubcategoryOptions(
  category: CancellationReasonCategory,
) {
  const values: readonly CancellationReasonSubcategory[] =
    SUBCATEGORY_VALUES_BY_CATEGORY[category];

  return values.map((value) =>
    CANCELLATION_REASON_SUBCATEGORY_OPTION_BY_VALUE.get(value)!,
  );
}

export function normalizeCancellationReasonDetails(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed.slice(0, CANCELLATION_REASON_DETAILS_MAX_LENGTH);
}
