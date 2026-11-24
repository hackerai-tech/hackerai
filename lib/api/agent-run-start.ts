// Shared by the Agent start route and server-side starts (queued follow-ups):
// run dedupe keys, Trigger placement, and the atomic chat-run association.
// Free of Next.js request handling so Trigger tasks can import it.
import { createHash } from "crypto";
import { auth, idempotencyKeys } from "@trigger.dev/sdk";
import type { UIMessage } from "ai";
import { api as goalApi } from "@/convex/_generated/api";
import { isConvexOutcomeUnknownError } from "@/lib/db/convex-client";
import { withAgentConvexScope } from "@/lib/api/agent-convex";
import { getGoal, goalServiceKey } from "@/lib/goals/server";
import {
  getChatById,
  replaceActiveTriggerRun,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import {
  AGENT_APPROVAL_TOKEN_EXPIRATION,
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier } from "@/types";

type AgentTriggerMachinePreset = "small-1x" | "small-2x";

const AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION: Record<
  SubscriptionTier,
  AgentTriggerMachinePreset
> = {
  free: "small-1x",
  pro: "small-2x",
  "pro-plus": "small-2x",
  ultra: "small-2x",
  team: "small-2x",
};

const AGENT_TRIGGER_PRIORITY_BY_SUBSCRIPTION: Record<SubscriptionTier, number> =
  {
    free: 0,
    pro: 5,
    "pro-plus": 5,
    ultra: 10,
    team: 5,
  };

export const getAgentTriggerPriority = (subscription: SubscriptionTier) =>
  AGENT_TRIGGER_PRIORITY_BY_SUBSCRIPTION[subscription];

/** Keep paid Agent starts on the latency-optimized 1 GB worker. */
export const getAgentTriggerMachine = (subscription: SubscriptionTier) =>
  AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION[subscription];

const getLastRequestMessageId = (messages: UIMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
};

export const buildAgentRunDedupeKeyParts = ({
  userId,
  chatId,
  requestMessages,
  regenerate,
  isAutoContinue,
  existingChatUpdateTime,
  triggerRequestedAt,
  agentRunRequestId,
}: {
  userId: string;
  chatId: string;
  requestMessages: UIMessage[];
  regenerate?: boolean;
  isAutoContinue?: boolean;
  existingChatUpdateTime?: number;
  triggerRequestedAt: number;
  agentRunRequestId?: string;
}) => {
  const operation = regenerate
    ? "regenerate"
    : isAutoContinue
      ? "auto-continue"
      : "send";
  const turnKey =
    (regenerate ? agentRunRequestId : undefined) ??
    getLastRequestMessageId(requestMessages) ??
    (existingChatUpdateTime !== undefined
      ? `chat-update:${existingChatUpdateTime}`
      : `request:${triggerRequestedAt}`);

  return ["agent-run", userId, chatId, operation, turnKey];
};

export const buildAgentRunIdempotencyKey = async (
  keyParts: ReturnType<typeof buildAgentRunDedupeKeyParts>,
) => idempotencyKeys.create(keyParts, { scope: "global" });

export const buildAgentApprovalSessionId = ({
  chatId,
  keyParts,
  approvalProtocolVersion,
  approvalWorkerVersion,
  approvalExternalDeploymentId,
}: {
  chatId: string;
  keyParts: ReturnType<typeof buildAgentRunDedupeKeyParts>;
  approvalProtocolVersion: number;
  approvalWorkerVersion: string | undefined;
  approvalExternalDeploymentId?: string;
}) => {
  const digest = createHash("sha256")
    .update(
      [
        `protocol:${approvalProtocolVersion}`,
        approvalWorkerVersion
          ? `worker:${approvalWorkerVersion}`
          : approvalExternalDeploymentId
            ? `deployment:${approvalExternalDeploymentId}`
            : "worker:unversioned",
        ...keyParts,
      ].join("\0"),
    )
    .digest("base64url")
    .slice(0, 32);
  return `agent-approval:v${approvalProtocolVersion}:${chatId}:${digest}`;
};

export type StartedAgentRunAccess = {
  publicAccessToken: string;
  approvalSessionPublicAccessToken?: string;
};

const AGENT_RUN_ASSOCIATION_UNCONFIRMED = "unconfirmed";

/** A started run may own its chat: keep its goal, run, Session and ownership. */
export const isAgentRunAssociationUnconfirmed = (error: unknown): boolean =>
  error instanceof ChatSDKError &&
  error.metadata?.agent_run_association === AGENT_RUN_ASSOCIATION_UNCONFIRMED;

/** The first chat guard that failed, in the guards' evaluation order. */
type AgentRunAssociationChatGuardReason =
  | "chat_missing"
  | "chat_owner_mismatch"
  | "chat_deleting"
  | "active_run_missing"
  | "active_run_mismatch"
  | "approval_session_mismatch";

/** Every result except "associated" leaves the original write inconclusive. */
type AgentRunAssociationReadBack =
  | {
      result:
        | "associated"
        | "chat_read_failed"
        | "goal_read_failed"
        | "goal_guard_mismatch"
        | "scope_failed";
    }
  | {
      result: "chat_guard_mismatch";
      chatGuardReason: AgentRunAssociationChatGuardReason;
    };

const associationChatGuardMismatch = (
  chatGuardReason: AgentRunAssociationChatGuardReason,
): AgentRunAssociationReadBack => ({
  result: "chat_guard_mismatch",
  chatGuardReason,
});

/**
 * Confirm the original association from an independent, bounded read. Even a
 * different owner is inconclusive: that owner can detach before the pending
 * write reaches its fence.
 */
const confirmStartedRunAssociation = async ({
  chatId,
  userId,
  runId,
  approvalSessionId,
  goalGeneration,
}: {
  chatId: string;
  userId: string;
  runId: string;
  approvalSessionId: string | undefined;
  goalGeneration?: number;
}): Promise<AgentRunAssociationReadBack> =>
  // A fresh budget: the failed write's deadline may already be spent. Chat and
  // goal reads share it.
  withAgentConvexScope(
    "startAssociationReadBack",
    async (convex): Promise<AgentRunAssociationReadBack> => {
      let chat: Awaited<ReturnType<typeof getChatById>>;
      try {
        chat = await getChatById({ id: chatId }, convex);
      } catch {
        return { result: "chat_read_failed" };
      }
      if (!chat) return associationChatGuardMismatch("chat_missing");
      if (chat.user_id !== userId)
        return associationChatGuardMismatch("chat_owner_mismatch");
      if (chat.deletion_started_at !== undefined)
        return associationChatGuardMismatch("chat_deleting");
      if (chat.active_trigger_run_id !== runId)
        return associationChatGuardMismatch(
          chat.active_trigger_run_id
            ? "active_run_mismatch"
            : "active_run_missing",
        );
      if (
        (chat.active_agent_approval_session_id ?? null) !==
        (approvalSessionId ?? null)
      )
        return associationChatGuardMismatch("approval_session_mismatch");
      if (goalGeneration === undefined) return { result: "associated" };
      let savedGoal: Awaited<ReturnType<typeof getGoal>>;
      try {
        savedGoal = await getGoal(chatId, userId, convex);
      } catch {
        return { result: "goal_read_failed" };
      }
      if (
        savedGoal != null &&
        savedGoal.deletedAt === undefined &&
        savedGoal.generation === goalGeneration &&
        (savedGoal.activeRunId === undefined || savedGoal.activeRunId === runId)
      )
        return { result: "associated" };
      return { result: "goal_guard_mismatch" };
    },
  ).catch((): AgentRunAssociationReadBack => ({ result: "scope_failed" }));

/** The chat's run owner, read before dispatch for an ordinary start. */
export type AgentRunPreviousOwner = {
  runId: string | null;
  approvalSessionId: string | null;
};

export const finalizeStartedAgentRun = async ({
  expectedRunId = null,
  chatId,
  userId,
  runId,
  approvalSessionId,
  goal,
  previousOwner,
}: {
  chatId: string;
  userId: string;
  runId: string;
  approvalSessionId: string | undefined;
  goal?: { userId: string; generation: number };
  expectedRunId?: string | null;
  // Required without a goal: the owner snapshot read before dispatch.
  previousOwner?: AgentRunPreviousOwner;
}): Promise<StartedAgentRunAccess> => {
  let failureStage:
    | "create_tokens"
    | "associate_run"
    | "cancel_previous_run"
    | "close_previous_session" = "create_tokens";
  let access: StartedAgentRunAccess | undefined;
  try {
    const [publicAccessToken, approvalSessionPublicAccessToken] =
      await Promise.all([
        auth.createPublicToken({
          scopes: { read: { runs: [runId] } },
          // 6h is enough to cover the max task duration plus reconnect grace.
          expirationTime: "6h",
        }),
        approvalSessionId
          ? auth.createPublicToken({
              scopes: {
                write: { sessions: approvalSessionId },
              } as any,
              expirationTime: AGENT_APPROVAL_TOKEN_EXPIRATION,
            })
          : Promise.resolve(undefined),
      ]);
    access = {
      publicAccessToken,
      ...(approvalSessionPublicAccessToken
        ? { approvalSessionPublicAccessToken }
        : {}),
    };

    failureStage = "associate_run";
    let expectedPreviousRunId = expectedRunId;
    let expectedApprovalSessionId: string | null = null;
    if (!goal) {
      if (!previousOwner)
        throw new Error("An ordinary Agent start needs its owner snapshot");
      const previousRunId = previousOwner.runId;
      if (
        previousRunId !== null &&
        previousRunId !== runId &&
        previousRunId !== expectedRunId
      ) {
        // Another admission may have attached this same run during dispatch.
        // Let Convex decide against the current owner. Without cleaning up
        // the observed owner, only an empty or already matching claim is safe.
        expectedPreviousRunId = null;
      } else {
        expectedApprovalSessionId = previousOwner.approvalSessionId;
        // Keep the ownership record until both cleanup operations finish.
        // A failed close must remain discoverable by Stop or a later send.
        if (previousRunId && previousRunId !== runId) {
          failureStage = "cancel_previous_run";
          await cancelAgentTriggerRun(previousRunId);
        }
        if (
          expectedApprovalSessionId &&
          expectedApprovalSessionId !== approvalSessionId
        ) {
          failureStage = "close_previous_session";
          await closeAgentApprovalSession(
            expectedApprovalSessionId,
            "agent-run-replaced",
          );
        }
      }
    }

    failureStage = "associate_run";
    // An isolated client: an unrelated chat's pending write on the process
    // singleton cannot hold this admission's association in the SDK queue.
    const association = await withAgentConvexScope(
      "startAssociation",
      async (convex) => {
        // Goal startup has its own generation fence and must not reattach a
        // worker that already finished. Ordinary sends atomically replace the
        // prior owner.
        return goal
          ? (await convex.client.mutation(
              goalApi.agentGoals.associateStartedRun,
              {
                serviceKey: goalServiceKey(),
                chatId,
                runId,
                approvalSessionId,
                ...goal,
              },
            ))
            ? { previousRunId: null, previousApprovalSessionId: null }
            : ("stale" as const)
          : await replaceActiveTriggerRun(
              {
                expectedRunId: expectedPreviousRunId,
                expectedApprovalSessionId,
                chatId,
                triggerRunId: runId,
                approvalSessionId: approvalSessionId ?? null,
              },
              convex,
            );
      },
    );
    if (association === "stale") {
      throw new ChatSDKError(
        "bad_request:api",
        "Another Agent run started in this chat. Reconnect to that run before sending again.",
        { agent_run_association: association },
      );
    }
    if (typeof association === "string") {
      throw new ChatSDKError(
        "not_found:chat",
        "The chat was deleted while the Agent run was starting.",
        { agent_run_association: association },
      );
    }

    return access;
  } catch (error) {
    // A lost response is not a rejection. Decide it before any cleanup that
    // would cancel, close or detach a run the chat may already own.
    if (
      access &&
      failureStage === "associate_run" &&
      isConvexOutcomeUnknownError(error)
    ) {
      const readBack = await confirmStartedRunAssociation({
        chatId,
        userId,
        runId,
        approvalSessionId,
        goalGeneration: goal?.generation,
      });
      const associated = readBack.result === "associated";
      try {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "agent_run_association_read_back",
            service: "hackerai-web",
            timestamp: new Date().toISOString(),
            read_back_outcome: associated ? "associated" : "inconclusive",
            read_back_result_version: 1,
            read_back_result: readBack.result,
            // A finite guard name only, never the read owner, run or Session.
            ...(readBack.result === "chat_guard_mismatch"
              ? {
                  read_back_chat_guard_version: 1,
                  read_back_chat_guard_reason: readBack.chatGuardReason,
                }
              : {}),
            goal_association: goal !== undefined,
            chat_id: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
              chatId,
            )
              ? chatId
              : undefined,
            trigger_run_id: /^run_[a-z0-9]{20,64}$/.test(runId)
              ? runId
              : undefined,
          }),
        );
      } catch {
        // Optional diagnostics must not change the association decision.
      }
      if (associated) return access;
      // The sent association may still commit. Keep its run, Session and
      // ownership for reconnect; never replay the write or redispatch.
      throw new ChatSDKError(
        "offline:api",
        "The Agent run started, but its link to this chat could not be confirmed. Reload the chat to reconnect to it before sending again.",
        { agent_run_association: AGENT_RUN_ASSOCIATION_UNCONFIRMED },
      );
    }
    // A started run must never be returned when its chat association fails.
    // Close both resources because Session close and run cancellation are
    // independently idempotent and either one may already be terminal.
    const cleanupResults = await Promise.allSettled([
      closeAgentApprovalSession(
        approvalSessionId,
        "agent-run-association-failed",
      ),
      cancelAgentTriggerRun(runId),
      withAgentConvexScope("startCleanup", (convex) =>
        setActiveTriggerRun(
          {
            chatId,
            triggerRunId: null,
            approvalSessionId: null,
            expectedRunId: runId,
            clearApprovalPending: true,
          },
          convex,
        ),
      ),
    ]);
    try {
      const associationRejection =
        error instanceof ChatSDKError
          ? error.metadata?.agent_run_association
          : undefined;
      const [sessionCleanup, runCleanup, associationCleanup] = cleanupResults;
      const clearAssociationResult =
        associationCleanup.status === "rejected"
          ? "rejected"
          : typeof associationCleanup.value === "string" &&
              ["updated", "stale", "not_found", "deleting"].includes(
                associationCleanup.value,
              )
            ? associationCleanup.value
            : "unrecognized";
      // Helper fulfillment is not proof of Trigger termination or lasting chat
      // ownership. Keep only the conditional write's bounded acknowledgement.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "agent_run_handoff_cleanup_result",
          service: "hackerai-web",
          timestamp: new Date().toISOString(),
          failure_stage: failureStage,
          // This is the original guard rejection, not the later clear result.
          // Null leaves the original association outcome unobserved.
          association_rejection_reason:
            failureStage === "associate_run" &&
            (associationRejection === "stale" ||
              associationRejection === "not_found" ||
              associationRejection === "deleting")
              ? associationRejection
              : null,
          chat_id: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(chatId)
            ? chatId
            : undefined,
          trigger_run_id: /^run_[a-z0-9]{20,64}$/.test(runId)
            ? runId
            : undefined,
          close_session_status: approvalSessionId
            ? sessionCleanup.status
            : "not_requested",
          cancel_run_status: runCleanup.status,
          clear_association_result: clearAssociationResult,
        }),
      );
    } catch {
      // Optional diagnostics must not replace the original handoff failure.
    }
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === "rejected") {
        console.error("Failed to clean up an unreturned Agent run:", {
          chatId,
          runId,
          error: cleanupResult.reason,
        });
      }
    }
    throw error;
  }
};
