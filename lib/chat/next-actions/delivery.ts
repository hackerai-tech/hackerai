/** Bounded metadata only. Never expose exception messages or request content. */
export const NEXT_ACTIONS_REASON_HEADER = "X-HackerAI-Next-Actions-Reason";
export const NEXT_ACTIONS_DELIVERY_REASONS = [
  "invalid_request",
  "analytics_unavailable",
  "not_offered",
  "auth_required",
  "access_denied",
  "preference_disabled",
  "chat_unavailable",
  "source_canceled",
  "source_waiting",
  "source_active",
  "source_not_successful",
  "source_stale",
  "goal_complete",
  "context_empty",
  "saved_consumed",
  "saved_incompatible",
  "restore_miss",
  "source_expired",
  "reservation_unavailable",
  "generation_reserved_or_budgeted",
  "provider_unavailable",
  "source_changed",
  "prediction_empty",
  "save_rejected",
  "server_error",
  "server_deadline",
  "request_aborted",
] as const;
export type NextActionsDeliveryReason =
  (typeof NEXT_ACTIONS_DELIVERY_REASONS)[number];
const reasons = new Set<string>(NEXT_ACTIONS_DELIVERY_REASONS);
export function nextActionsDeliveryReason(
  value: unknown,
): NextActionsDeliveryReason | undefined {
  return typeof value === "string" && reasons.has(value)
    ? (value as NextActionsDeliveryReason)
    : undefined;
}
export type NextActionsFailurePhase =
  "http" | "decode" | "schema" | "network" | "deadline" | "lifecycle";
