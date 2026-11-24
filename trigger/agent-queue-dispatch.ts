import { task, tasks } from "@trigger.dev/sdk";
import type { UIMessage } from "ai";
import { api } from "@/convex/_generated/api";
import { getConvexClient, setConvexUrl } from "@/lib/db/convex-client";
import {
  getChatById,
  getCurrentAgentEntitlementContext,
  handleInitialChatAndUserMessage,
} from "@/lib/db/actions";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { assertFreeAgentGates } from "@/lib/api/chat-stream-helpers";
import { isAgentSteeringEnabled } from "@/lib/experiments/agent-steering.server";
import { AGENT_TRIGGER_TASK_ID } from "@/lib/api/agent-endpoints";
import {
  buildAgentRunDedupeKeyParts,
  buildAgentRunIdempotencyKey,
  finalizeStartedAgentRun,
  getAgentTriggerMachine,
  getAgentTriggerPriority,
} from "@/lib/api/agent-run-start";
import type { AgentLongPayload, agentLongTask } from "./agent-long";
import {
  captureAgentFollowUp,
  type QueueDispatchSkipReason,
} from "@/lib/analytics/agent-follow-up";

const QUEUE_DISPATCH_TASK_ID = "agent-queue-dispatch";

type QueueDispatchPayload = {
  /** The finished run's settings, reused for the next turn as T3 Code does. */
  run: AgentLongPayload;
  completedRunId: string;
  queuedId: string;
  /** For analytics: when it was first queued, and whether it was a steer. */
  sentAt?: number;
  fromSteer?: boolean;
};

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

// Approval sessions need the browser's live approval channel, so a queued
// message for such a run waits for the user instead of starting unattended.
const runsUnattended = (payload: AgentLongPayload) =>
  (payload.agentPermissionMode ?? "full_access") === "full_access";

/**
 * Starts the next queued follow-up after a run finished, without a browser.
 * It reuses the Agent start route's admission rules that do not depend on the
 * request: account access, a fresh entitlement read, free-tier gates, saving
 * the user message, the same run dedupe key and the same chat association.
 * The queued message's ID is the user message ID, so a browser sending the
 * same message at the same time resolves to this one run.
 */
export const agentQueueDispatch = task({
  id: QUEUE_DISPATCH_TASK_ID,
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async ({
    run,
    completedRunId,
    queuedId,
    sentAt,
    fromSteer,
  }: QueueDispatchPayload) => {
    if (run.convexUrl) setConvexUrl(run.convexUrl);
    const { chatId, userId } = run;
    const report = {
      userId,
      chatId,
      subscription: run.subscription,
      fromSteer,
      dedupeKey: queuedId,
    };
    const skip = async (skipReason: QueueDispatchSkipReason) => {
      await captureAgentFollowUp("queue_dispatch_skipped", {
        ...report,
        runId: completedRunId,
        skipReason,
      });
      return { outcome: skipReason };
    };
    const claim = {
      serviceKey: serviceKey(),
      chatId,
      userId,
      id: queuedId,
      completedRunId,
    };
    const release = () =>
      getConvexClient()
        .mutation(api.queuedMessages.releaseDispatch, claim)
        .catch(() => undefined);
    let messageSaved = false;
    try {
      const queued = await getConvexClient().query(
        api.queuedMessages.getClaimedForDispatch,
        claim,
      );
      // Sent or removed elsewhere since the claim.
      if (!queued) return await skip("not_queued");

      await assertUserCanMakeCostIncurringRequest(userId);
      const fresh = await getCurrentAgentEntitlementContext({
        userId,
        organizationId: run.organizationId,
      });
      if (
        fresh.subscription !== run.subscription ||
        fresh.organizationId !== run.organizationId
      ) {
        await release();
        return await skip("entitlement_changed");
      }
      assertFreeAgentGates({
        mode: "agent",
        subscription: run.subscription,
        sandboxPreference: run.sandboxPreference,
      });

      const chat = await getChatById({ id: chatId });
      if (
        !chat ||
        chat.user_id !== userId ||
        chat.deletion_started_at !== undefined ||
        chat.active_trigger_run_id
      ) {
        await release();
        return await skip("chat_unavailable");
      }

      const userMessage = {
        id: queued.id,
        role: "user" as const,
        parts: [
          ...((queued.files ?? []) as UIMessage["parts"]),
          ...(queued.text.trim()
            ? [{ type: "text" as const, text: queued.text }]
            : []),
        ],
      };
      // Saving the user message retires its queued row in the same write.
      await handleInitialChatAndUserMessage({
        chatId,
        userId,
        messages: [userMessage],
        chat,
        projectId: chat.project_id,
        sandboxType: run.sandboxPreference ?? "e2b",
      });
      messageSaved = true;

      const now = Date.now();
      const nextPayload: AgentLongPayload = {
        ...run,
        // The worker rehydrates history, including this message, from Convex.
        messages: [],
        localDesktopAttachmentsPrepared: false,
        baseTodos: [],
        isAutoContinue: false,
        isAutomaticContinuation: false,
        regenerate: false,
        isNewChat: false,
        limitRescue: undefined,
        approvalSessionId: undefined,
        resumeFromFinishReason: undefined,
        goalGeneration: undefined,
        goalWorkerVersion: undefined,
        analyticsRequestContext: undefined,
        requestTiming: { routeStartedAt: now, triggerRequestedAt: now },
      };
      const tags = [
        `user_${userId}`,
        `chat_${chatId}`,
        ...(run.subscription !== "free" ? [`sub_${run.subscription}`] : []),
        "permission_full_access",
      ];
      const priority = getAgentTriggerPriority(run.subscription);
      const handle = await tasks.trigger<typeof agentLongTask>(
        AGENT_TRIGGER_TASK_ID,
        nextPayload,
        {
          ...(priority > 0 ? { priority } : {}),
          machine: getAgentTriggerMachine(run.subscription),
          tags,
          region: run.triggerRegion,
          idempotencyKey: await buildAgentRunIdempotencyKey(
            buildAgentRunDedupeKeyParts({
              userId,
              chatId,
              requestMessages: [userMessage as UIMessage],
              triggerRequestedAt: now,
            }),
          ),
          idempotencyKeyTTL: "6h",
          metadata: {
            status: "queued",
            chatId,
            userId,
            subscription: run.subscription,
            queuedFollowUp: true,
          },
        },
      );
      await finalizeStartedAgentRun({
        chatId,
        userId,
        runId: handle.id,
        approvalSessionId: undefined,
        previousOwner: {
          runId: chat.active_trigger_run_id ?? null,
          approvalSessionId: chat.active_agent_approval_session_id ?? null,
        },
      });
      await captureAgentFollowUp("queue_dispatch_started", {
        ...report,
        runId: handle.id,
        ...(sentAt !== undefined ? { queuedForMs: Date.now() - sentAt } : {}),
      });
      return { outcome: "started" as const, runId: handle.id };
    } catch (error) {
      // Once saved, the message is in the transcript like any failed send.
      if (!messageSaved) await release();
      await captureAgentFollowUp("queue_dispatch_failed", {
        ...report,
        runId: completedRunId,
      });
      throw error;
    }
  },
});

/**
 * Called when an Agent run finishes normally. Claims the chat's next queued
 * message and starts it on the server, so it is sent even with no browser
 * open. Never throws: a failure leaves the message queued for the user.
 */
export async function scheduleQueuedMessageDispatch(
  payload: AgentLongPayload,
  completedRunId: string,
) {
  // Goals schedule their own continuation and own their chat.
  if (payload.goalGeneration !== undefined || !runsUnattended(payload)) return;
  if (payload.convexUrl) setConvexUrl(payload.convexUrl);
  let claimedId: string | undefined;
  try {
    if (!(await isAgentSteeringEnabled(payload.userId))) return;
    const claimed = await getConvexClient().mutation(
      api.queuedMessages.claimNextForDispatch,
      {
        serviceKey: serviceKey(),
        chatId: payload.chatId,
        userId: payload.userId,
        completedRunId,
      },
    );
    if (!claimed) return;
    claimedId = claimed.id;
    await captureAgentFollowUp("queue_dispatch_claimed", {
      userId: payload.userId,
      chatId: payload.chatId,
      runId: completedRunId,
      subscription: payload.subscription,
      fromSteer: claimed.fromSteer,
      dedupeKey: claimed.id,
    });
    await tasks.trigger<typeof agentQueueDispatch>(
      QUEUE_DISPATCH_TASK_ID,
      {
        run: { ...payload, messages: [] },
        completedRunId,
        queuedId: claimed.id,
        sentAt: claimed.sentAt,
        fromSteer: claimed.fromSteer,
      },
      {
        idempotencyKey: `queue-dispatch:${completedRunId}`,
        idempotencyKeyTTL: "1d",
      },
    );
  } catch (error) {
    if (claimedId)
      await getConvexClient()
        .mutation(api.queuedMessages.releaseDispatch, {
          serviceKey: serviceKey(),
          chatId: payload.chatId,
          userId: payload.userId,
          id: claimedId,
          completedRunId,
        })
        .catch(() => undefined);
    console.warn("Could not send the next queued message", {
      chatId: payload.chatId,
      completedRunId,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
