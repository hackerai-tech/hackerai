import { runs } from "@trigger.dev/sdk";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";

// agent-long returns normally for handled request errors after emitting these
// terminal markers. Trigger's COMPLETED status alone does not prove success.
function completedAgentFailed(run: {
  metadata?: Record<string, unknown>;
  tags?: string[];
}) {
  const status = run.metadata?.status;
  return (
    (typeof status === "string" &&
      [
        "rate_limited",
        "user_correctable",
        "reconnect_required",
        "chat_not_found",
        "failed",
      ].includes(status)) ||
    run.tags?.some(
      (tag) =>
        tag === "rate_limited" ||
        tag.startsWith("blocked_code_") ||
        tag.startsWith("user_correctable_"),
    ) === true
  );
}

/** A cleared chat association proves cleanup, not successful Agent completion. */
export async function reconcileScheduleRuns(userId?: string) {
  const db = getConvexClient();
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
  await db.mutation(api.schedules.recoverUncertainStarts, {
    serviceKey,
    ...(userId ? { userId } : {}),
  });
  const pending = await db.query(api.schedules.unsettled, {
    serviceKey,
    ...(userId ? { userId } : {}),
  });
  if (!userId) {
    const abandoned = await db.query(api.schedules.abandonedDispatches, {
      serviceKey,
    });
    for (const { dispatcherRunId, ...receipt } of abandoned) {
      let terminal = false;
      try {
        const run = await runs.retrieve(dispatcherRunId);
        terminal = [
          "COMPLETED",
          "FAILED",
          "CANCELED",
          "CRASHED",
          "SYSTEM_FAILURE",
          "EXPIRED",
          "TIMED_OUT",
        ].includes(run.status);
      } catch {
        /* Preserve ambiguous dispatcher state. */
      }
      await db.mutation(api.schedules.failDispatcher, {
        serviceKey,
        ...receipt,
        onlyCheck: !terminal,
      });
    }
  }
  for (let start = 0; start < pending.length; start += 5) {
    await Promise.all(
      pending.slice(start, start + 5).map(async (row) => {
        let status:
          "finished" | "failed" | "canceled" | "unconfirmed" | "pending" =
          "pending";
        try {
          const run = await runs.retrieve(row.triggerRunId);
          status =
            run.status === "COMPLETED"
              ? completedAgentFailed(run)
                ? "failed"
                : "finished"
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
                  : "pending";
        } catch {
          // The backend only settles an unknown outcome after independently verified task cleanup.
          status = "unconfirmed";
        }
        await db.mutation(api.schedules.recordOutcome, {
          serviceKey,
          id: row.id,
          triggerRunId: row.triggerRunId,
          status,
        });
      }),
    );
  }
}
