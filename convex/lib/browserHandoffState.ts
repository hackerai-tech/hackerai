import type { Doc } from "../_generated/dataModel";

/** Expired control grants and stalled resumes need the user's attention again. */
export function effectiveBrowserHandoffState(
  row: Pick<
    Doc<"browser_handoffs">,
    "state" | "grant_expires_at" | "updated_at"
  >,
  now = Date.now(),
) {
  if (
    ((row.state === "human" || row.state === "claiming") &&
      (row.grant_expires_at ?? 0) <= now) ||
    (row.state === "resuming" && row.updated_at + 30_000 <= now)
  ) {
    return "recovery" as const;
  }
  return row.state;
}
