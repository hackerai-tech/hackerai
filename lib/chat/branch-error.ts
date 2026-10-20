import { ConvexError } from "convex/values";

/** Keep branch guidance fixed instead of displaying arbitrary server errors. */
export function getBranchErrorMessage(error: unknown): string {
  if (
    error instanceof ConvexError &&
    error.data !== null &&
    typeof error.data === "object" &&
    !Array.isArray(error.data) &&
    "code" in error.data &&
    error.data.code === "BRANCH_HISTORY_TOO_LARGE"
  ) {
    return "This task is too large to branch at this message. Try branching from an earlier message. Your original task is unchanged.";
  }

  return "Failed to branch task. Please try again.";
}
