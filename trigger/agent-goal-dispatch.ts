import { task, tasks, sessions } from "@trigger.dev/sdk";
import { api } from "@/convex/_generated/api";
import { getConvexClient, setConvexUrl } from "@/lib/db/convex-client";
import {
  getGoal,
  goalServiceKey,
  assertGoalExecutionAllowed,
} from "@/lib/goals/server";
import type { AgentLongPayload } from "./agent-long";

/** A short dispatcher, not another model loop. The normal worker owns all billing and cleanup. */
export const agentGoalDispatch = task({
  id: "agent-goal-dispatch",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (payload: AgentLongPayload, { ctx }) => {
    if (payload.goalGeneration === undefined || !payload.convexUrl)
      throw new Error("Missing goal identity");
    setConvexUrl(payload.convexUrl);
    let startedRunId: string | undefined;
    try {
      const claimed = await getConvexClient().mutation(
        api.agentGoals.claimDispatch,
        {
          serviceKey: goalServiceKey(),
          chatId: payload.chatId,
          userId: payload.userId,
          generation: payload.goalGeneration,
          dispatchId: ctx.run.id,
        },
      );
      if (!claimed) return;
      await assertGoalExecutionAllowed(payload);
      const goal = await getGoal(payload.chatId, payload.userId);
      if (
        !goal ||
        !["queued", "waiting"].includes(goal?.state ?? "") ||
        goal.generation !== payload.goalGeneration
      )
        return;
      const nextPayload: AgentLongPayload = {
        ...payload,
        messages: [],
        localDesktopAttachmentsPrepared: false,
        isAutoContinue: true,
        isAutomaticContinuation: true,
        isNewChat: false,
        regenerate: false,
        limitRescue: undefined,
        requestTiming: undefined,
        approvalSessionId: undefined,
      };
      const permission = payload.agentPermissionMode ?? "full_access";
      const tags = [
        `user_${payload.userId}`,
        `chat_${payload.chatId}`,
        `sub_${payload.subscription}`,
        `permission_${permission}`,
      ];
      if (permission === "ask_approval" || permission === "auto_review") {
        const sessionId = `goal:${goal._id}:${goal.generation}`;
        nextPayload.approvalSessionId = sessionId;
        const session = await sessions.start({
          type: `agent-long-approval.v${payload.approvalProtocolVersion}`,
          externalId: sessionId,
          taskIdentifier: "agent-long",
          tags,
          metadata: {
            chatId: payload.chatId,
            userId: payload.userId,
            status: "queued",
            goalGeneration: payload.goalGeneration,
          },
          triggerConfig: {
            basePayload: nextPayload,
            tags,
            machine: "small-2x",
            region: payload.triggerRegion,
            lockToVersion: payload.goalWorkerVersion ?? ctx.deployment?.version,
          },
        });
        startedRunId = session.runId;
      } else {
        const handle = await tasks.trigger("agent-long", nextPayload, {
          idempotencyKey: `goal:${goal._id}:${goal.generation}`,
          idempotencyKeyTTL: "30d",
          metadata: {
            chatId: payload.chatId,
            userId: payload.userId,
            status: "queued",
            goalGeneration: payload.goalGeneration,
          },
          tags,
          machine: "small-2x",
          region: payload.triggerRegion,
          version: payload.goalWorkerVersion ?? ctx.deployment?.version,
        });
        startedRunId = handle.id;
      }
      // The worker claims the generation and installs its run/approval handle
      // atomically before any costly work. Late dispatcher responses cannot replace it.
      return { runId: startedRunId };
    } catch (error) {
      await getConvexClient().mutation(api.agentGoals.failDispatch, {
        serviceKey: goalServiceKey(),
        chatId: payload.chatId,
        userId: payload.userId,
        generation: payload.goalGeneration,
      });
      throw error;
    }
  },
});

export async function scheduleGoalContinuation(
  payload: AgentLongPayload,
  completedRunId: string,
) {
  if (payload.goalGeneration === undefined) return;
  if (payload.convexUrl) setConvexUrl(payload.convexUrl);
  let generation = payload.goalGeneration;
  try {
    const goal = await getGoal(payload.chatId, payload.userId);
    if (
      !goal ||
      !["queued", "waiting"].includes(goal.state) ||
      goal.continuationSourceRunId !== completedRunId
    )
      return;
    generation = goal.generation;
    await tasks.trigger(
      "agent-goal-dispatch",
      { ...payload, goalGeneration: goal.generation, messages: [] },
      {
        idempotencyKey: `goal-dispatch:${goal._id}:${goal.generation}`,
        idempotencyKeyTTL: "30d",
        delay: new Date(Math.max(Date.now() + 5000, goal.waitUntil ?? 0)),
        version: payload.goalWorkerVersion,
      },
    );
  } catch {
    await getConvexClient().mutation(api.agentGoals.failDispatch, {
      serviceKey: goalServiceKey(),
      chatId: payload.chatId,
      userId: payload.userId,
      generation,
    });
  }
}
