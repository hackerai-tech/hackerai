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
      dispatcherId: ctx.run.id,
    });
  },
  onCancel: async ({ payload, ctx }) => {
    await getConvexClient().mutation(api.schedules.failDispatcher, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      scheduleId: payload.scheduleId as Id<"agent_schedules">,
      revision: payload.revision,
      ...(payload.at !== undefined ? { at: payload.at } : {}),
      manual: payload.manual === true,
      dispatcherId: ctx.run.id,
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
    },
    { ctx },
  ) => {
    // Use only this worker's environment. A caller cannot select another backend.
    const db = getConvexClient();
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
    const id = payload.scheduleId as Id<"agent_schedules">;
    const schedule = await db.query(api.schedules.getForDispatch, {
      serviceKey,
      id,
    });
    if (!schedule || schedule.revision !== payload.revision)
      return { status: "stale" };
    const claim = await db.mutation(api.schedules.claim, {
      serviceKey,
      id,
      userId: schedule.userId,
      revision: payload.revision,
      ...(payload.at !== undefined ? { at: payload.at } : {}),
      manual: payload.manual === true,
      dispatcherId: ctx.run.id,
      chatId: randomUUID(),
    });
    if (!claim) return { status: "skipped" };
    const finish = (
      status: "started" | "failed" | "skipped",
      detail?: string,
      triggerRunId?: string,
    ) =>
      db.mutation(api.schedules.finishDispatch, {
        serviceKey,
        id: claim.id,
        dispatcherId: ctx.run.id,
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
          sandboxPreference: "e2b",
          agentPermissionMode: "full_access",
          ...(schedule.definition.model !== "default"
            ? { selectedModel: `hackerai-${schedule.definition.model}` }
            : {}),
        }),
      },
    );
    const response = await createAgentTriggerPost({
      endpoint: "/api/agent",
      resolveIdentity: async () => ({
        userId: schedule.userId,
        emailVerified: true,
        ...entitlement,
      }),
    })(request);
    if (!response.ok) {
      // Keep failure details content-free. The normal Agent route owns detailed diagnostics.
      await finish(
        "failed",
        response.status === 429
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
    await reconcileScheduleRuns();
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
    return { dispatched: due.length };
  },
});
