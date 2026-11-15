import { ConvexError } from "convex/values";

/** Existing reconcileGoal awaits, in order; a failure names the last one entered. */
export const GOAL_RECONCILIATION_STEPS = [
  "get_goal",
  "retrieve_run",
  "finish_goal",
  "clear_active_run",
  "capture_lifecycle",
  "reload_goal",
] as const;
export type GoalReconciliationStep = (typeof GOAL_RECONCILIATION_STEPS)[number];

export type GoalReconciliationFailureKind =
  | "goal_chat_unavailable"
  | "chat_access_suspended"
  | "type_error"
  | "convex_error"
  | "other_error"
  | "thrown_value"
  | "unreadable_error";

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Classify a reconciliation failure from own data properties only. Accessors,
 * inherited fields and error contents are never evaluated or returned, and the
 * request ID is a Convex backend join key, not proof of the original cause.
 */
export function classifyGoalReconciliationFailure(error: unknown): {
  failureKind: GoalReconciliationFailureKind;
  convexRequestId: string;
} {
  try {
    let failureKind: GoalReconciliationFailureKind =
      error instanceof TypeError
        ? "type_error"
        : error instanceof ConvexError
          ? "convex_error"
          : error instanceof Error
            ? "other_error"
            : "thrown_value";
    let convexRequestId = "none";
    if (error && typeof error === "object") {
      const data = Object.getOwnPropertyDescriptor(error, "data")?.value;
      if (data === "Goal chat unavailable")
        failureKind = "goal_chat_unavailable";
      else if (
        data &&
        typeof data === "object" &&
        Object.getOwnPropertyDescriptor(data, "code")?.value ===
          "CHAT_ACCESS_SUSPENDED"
      )
        failureKind = "chat_access_suspended";
      const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
      if (typeof message === "string" && message.length <= MAX_MESSAGE_LENGTH)
        convexRequestId =
          message
            .match(/\[Request ID:\s*([a-f0-9]{16})\]/i)?.[1]
            .toLowerCase() ?? "none";
    }
    return { failureKind, convexRequestId };
  } catch {
    return { failureKind: "unreadable_error", convexRequestId: "none" };
  }
}
