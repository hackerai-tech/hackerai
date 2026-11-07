import { runs } from "@trigger.dev/sdk";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";

/** A cleared chat association proves cleanup, not successful Agent completion. */
export async function reconcileScheduleRuns(userId?: string) {
  const db = getConvexClient();
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
  const pending = await db.query(api.schedules.unsettled, {
    serviceKey,
    ...(userId ? { userId } : {}),
  });
  // Bounded batches avoid bursting the provider API for an account's recent runs.
  for (let start = 0; start < pending.length; start += 5) {
    await Promise.all(
      pending.slice(start, start + 5).map(async (row) => {
        try {
          const run = await runs.retrieve(row.triggerRunId);
          const status =
            run.status === "COMPLETED"
              ? "finished"
              : run.status === "CANCELED"
                ? "canceled"
                : [
                      "FAILED",
                      "CRASHED",
                      "SYSTEM_FAILURE",
                      "EXPIRED",
                      "TIMED_OUT",
                    ].includes(run.status)
                  ? "failed"
                  : null;
          if (status)
            await db.mutation(api.schedules.recordOutcome, {
              serviceKey,
              id: row.id,
              triggerRunId: row.triggerRunId,
              status,
            });
        } catch {
          // Preserve unknown state; failed status reads never imply completion.
        }
      }),
    );
  }
}
