import { findScheduledConnection } from "@/lib/schedules/local-execution";
import { randomUUID } from "node:crypto";
import { schedules, schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getConvexClient } from "@/lib/db/convex-client";
import { getCurrentAgentEntitlementContext } from "@/lib/db/actions";
import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { reconcileScheduleRuns } from "@/lib/schedules/reconcile";
import { phLogger } from "@/lib/posthog/server";
import { canUseSchedules } from "@/lib/schedules/access";

export const scheduledAgentRun = schemaTask({
  schema: z.object({
    scheduleId: z.string().min(1),
    revision: z.number().int().positive(),
    at: z.number().int().positive().optional(),
    manual: z.boolean().optional(),
    manualRequestId: z.string().optional(),
    receiptId: z.string().optional(),
  }),
  id: "scheduled-agent-run",
  maxDuration: 300,
  onFailure: async ({ payload, ctx }) => {
    await getConvexClient().mutation(api.schedules.failDispatcher, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      scheduleId: payload.scheduleId as Id<"agent_schedules">,
      revision: payload.revision,
      ...(payload.at !== undefined ? { at: payload.at } : {}),
      manual: payload.manual === true,
      dispatcherId: payload.manualRequestId ?? ctx.run.id,
    });
  },
  onCancel: async ({ payload, ctx }) => {
    await getConvexClient().mutation(api.schedules.failDispatcher, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      scheduleId: payload.scheduleId as Id<"agent_schedules">,
      revision: payload.revision,
      ...(payload.at !== undefined ? { at: payload.at } : {}),
      manual: payload.manual === true,
      dispatcherId: payload.manualRequestId ?? ctx.run.id,
    });
  },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (
    payload: {
      scheduleId: string;
      revision: number;
      at?: number;
      manual?: boolean;
      manualRequestId?: string;
      receiptId?: string;
    },
    { ctx },
  ) => {
    // Use only this worker's environment. A caller cannot select another backend.
    const db = getConvexClient();
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
    const id = payload.scheduleId as Id<"agent_schedules">;
    const dispatcherId = payload.manualRequestId ?? ctx.run.id;
    const schedule = await db.query(api.schedules.getForDispatch, {
      serviceKey,
      id,
    });
    if (!schedule || schedule.revision !== payload.revision) {
      if (payload.receiptId)
        await db.mutation(api.schedules.finishDispatch, {
          serviceKey,
          id: payload.receiptId as Id<"schedule_runs">,
          dispatcherId,
          status: "skipped",
          detail: "Schedule changed before the run started.",
        });
      if (!payload.receiptId)
        await db.mutation(api.schedules.failDispatcher, {
          serviceKey,
          scheduleId: id,
          revision: payload.revision,
          ...(payload.at !== undefined ? { at: payload.at } : {}),
          manual: payload.manual === true,
          dispatcherId,
        });
      return { status: "stale" };
    }
    const claim = await db.mutation(api.schedules.claim, {
      serviceKey,
      id,
      userId: schedule.userId,
      revision: payload.revision,
      ...(payload.at !== undefined ? { at: payload.at } : {}),
      manual: payload.manual === true,
      dispatcherId,
      dispatcherRunId: ctx.run.id,
      chatId: randomUUID(),
    });
    if (!claim) {
      await db.mutation(api.schedules.failDispatcher, {
        serviceKey,
        scheduleId: id,
        revision: payload.revision,
        ...(payload.at !== undefined ? { at: payload.at } : {}),
        manual: payload.manual === true,
        dispatcherId,
      });
      return { status: "skipped" };
    }
    const finish = (
      status: "started" | "failed" | "skipped" | "uncertain_start",
      detail?: string,
      triggerRunId?: string,
    ) =>
      db.mutation(api.schedules.finishDispatch, {
        serviceKey,
        id: claim.id,
        dispatcherId,
        status,
        ...(detail ? { detail } : {}),
        ...(triggerRunId ? { triggerRunId } : {}),
      });
    const entitlement = await getCurrentAgentEntitlementContext({
      userId: schedule.userId,
      organizationId: schedule.organizationId,
    });
    const allowed = await canUseSchedules(
      schedule.userId,
      entitlement.subscription,
    );
    if (!allowed) {
      await finish(
        "skipped",
        "Schedules are unavailable for this account. Check your plan or try again later.",
      );
      return { status: "unavailable" };
    }
    // Re-read after the entitlement round trip: pause, edit, and delete fence queued starts.
    const current = await db.query(api.schedules.getForDispatch, {
      serviceKey,
      id,
    });
    if (
      !current ||
      current.revision !== payload.revision ||
      (!payload.manual &&
        !current.enabled &&
        current.definition.timing.type !== "once")
    ) {
      await finish("skipped", "Schedule changed before the run started.");
      return { status: "stale" };
    }
    const execution = schedule.definition.execution;
    if (execution) {
      if (
        !payload.manual &&
        payload.at !== undefined &&
        Date.now() - payload.at > 120_000
      ) {
        await finish(
          "skipped",
          "Missed: scheduled start expired. This run will not be replayed.",
        );
        return { status: "skipped" };
      }
      try {
        if (
          !(await findScheduledConnection(
            schedule.userId,
            execution.preference,
          ))
        ) {
          await finish(
            "skipped",
            "Missed: computer offline. This run will not be replayed.",
          );
          return { status: "skipped" };
        }
      } catch {
        await finish(
          "skipped",
          "Missed: could not verify the computer connection. Try Run now when connected.",
        );
        return { status: "skipped" };
      }
    }
    const request = new NextRequest(
      "https://internal.hackerai/scheduled-agent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatId: claim.chatId,
          agentRunRequestId: String(claim.id),
          messages: [
            {
              id: `${claim.id}-prompt`,
              role: "user",
              parts: [{ type: "text", text: schedule.definition.prompt }],
            },
          ],
          sandboxPreference: execution?.preference ?? "e2b",
          agentPermissionMode: "full_access",
          ...(schedule.definition.model !== "default"
            ? { selectedModel: `hackerai-${schedule.definition.model}` }
            : {}),
        }),
      },
    );
    if (
      !(await db.mutation(api.schedules.beginDispatch, {
        serviceKey,
        id: claim.id,
        dispatcherId,
      }))
    ) {
      await finish("skipped", "Schedule changed before the run started.");
      return { status: "stale" };
    }
    const response = await createAgentTriggerPost({
      endpoint: "/api/agent",
      ...(execution ? { scheduledLocalExecution: execution } : {}),
      resolveIdentity: async () => ({
        userId: schedule.userId,
        emailVerified: true,
        ...entitlement,
      }),
    })(request);
    if (!response.ok) {
      // Keep failure details content-free. The normal Agent route owns detailed diagnostics.
      await finish(
        response.status >= 500 ? "uncertain_start" : "failed",
        response.status >= 500
          ? "Could not confirm whether this Agent started. Check its task before replacing this schedule."
          : response.status === 429
            ? "Usage limit reached. Try again after your limit resets."
            : "Could not start the Agent. Check your account and try Run now.",
      );
      return { status: "failed" };
    }
    const { runId } = (await response.json()) as { runId: string };
    await finish("started", undefined, runId);
    phLogger.event("agent_schedule_run_started", {
      userId: schedule.userId,
      manual: payload.manual === true,
      timing_type: schedule.definition.timing.type,
    });
    await phLogger.flush();
    return { status: "started", chatId: claim.chatId };
  },
});

/** One durable clock per environment. Database claims deduplicate concurrent/retried ticks. */
export const dispatchAgentSchedules = schedules.task({
  id: "dispatch-agent-schedules",
  cron: {
    pattern: "* * * * *",
    window: "0m",
    environments: ["DEVELOPMENT", "PREVIEW", "STAGING", "PRODUCTION"],
  },
  maxDuration: 60,
  run: async () => {
    await reconcileScheduleRuns().catch((error) => {
      console.error("Schedule reconciliation failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    });
    const due = await getConvexClient().query(api.schedules.due, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    });
    for (const schedule of due) {
      await tasks.trigger<typeof scheduledAgentRun>(
        "scheduled-agent-run",
        {
          scheduleId: schedule.id,
          revision: schedule.revision,
          at: schedule.at,
        },
        {
          idempotencyKey: `schedule:${schedule.id}:${schedule.revision}:${schedule.at}:${Math.floor(Date.now() / 300000)}`,
          idempotencyKeyTTL: "24h",
        },
      );
    }
    const queued = await getConvexClient().query(api.schedules.queuedManual, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    });
    for (const request of queued) {
      await tasks.trigger<typeof scheduledAgentRun>(
        "scheduled-agent-run",
        {
          scheduleId: request.scheduleId,
          revision: request.revision,
          manual: true,
          manualRequestId: request.requestId,
          receiptId: request.id,
        },
        {
          idempotencyKey: `schedule-manual:${request.id}`,
          idempotencyKeyTTL: "24h",
        },
      );
    }
    return { dispatched: due.length + queued.length };
  },
});
