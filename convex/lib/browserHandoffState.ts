import type { Doc } from "../_generated/dataModel";
import {
  BROWSER_HANDOFF_ABANDON_AFTER_MS,
  BROWSER_HANDOFF_RESUME_GRACE_MS,
} from "../../lib/ai/browser-handoff/constants";

type HandoffTiming = Pick<
  Doc<"browser_handoffs">,
  "state" | "grant_expires_at" | "updated_at"
>;

/** Expired control grants and stalled resumes need the user's attention again. */
export function effectiveBrowserHandoffState(
  row: HandoffTiming,
  now = Date.now(),
) {
  if (
    ((row.state === "human" || row.state === "claiming") &&
      (row.grant_expires_at ?? 0) <= now) ||
    (row.state === "resuming" &&
      row.updated_at + BROWSER_HANDOFF_RESUME_GRACE_MS <= now)
  ) {
    return "recovery" as const;
  }
  return row.state;
}

/**
 * When a handoff nobody currently controls stops holding its run. Measured from
 * the backend transition or lease expiry that left it uncontrolled, never from
 * worker polls, browser keepalives or grant renewals. Active control, Agent
 * work and closed rows have no deadline.
 */
export function browserHandoffAbandonAfter(
  row: HandoffTiming & Pick<Doc<"browser_handoffs">, "input_expires_at">,
  now = Date.now(),
): number | null {
  if ((row.input_expires_at ?? 0) > now) return null;
  if (effectiveBrowserHandoffState(row, now) !== "recovery") {
    return row.state === "waiting"
      ? row.updated_at + BROWSER_HANDOFF_ABANDON_AFTER_MS
      : null;
  }
  const uncontrolledSince =
    row.state === "human" || row.state === "claiming"
      ? (row.grant_expires_at ?? row.updated_at)
      : row.state === "resuming"
        ? row.updated_at + BROWSER_HANDOFF_RESUME_GRACE_MS
        : row.updated_at;
  return uncontrolledSince + BROWSER_HANDOFF_ABANDON_AFTER_MS;
}
