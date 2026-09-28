import { generateId, type UIMessageStreamWriter } from "ai";
import { logger as triggerLogger, metadata, wait } from "@trigger.dev/sdk";
import * as triggerSdk from "@trigger.dev/sdk";

import { setActiveAgentApprovalPending } from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";
import type { AgentAutoReviewAssignment } from "@/lib/experiments/agent-auto-review";
import {
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
  getAgentApprovalTargetPrefixForSandbox,
  getAgentToolApprovalPromptKind,
  type AgentApprovalSandboxIdentity,
  type AgentAutoReviewLifecycleStatus,
  type AgentAutoReviewSummary,
  type AgentPermissionMode,
  type AgentToolApprovalInputRecord,
  type AgentToolApprovalPendingRequest,
  type AgentToolApprovalRequest,
  type AgentToolApprovalRequester,
} from "@/types";
import {
  deriveApprovedAgentTargetGrant,
  matchesAgentApprovalTargetGrant as matchesApprovalTargetGrant,
  type AgentApprovalTargetGrant,
  type PersistedAgentApprovalTargetGrant,
} from "@/lib/chat/agent-approval-grants";
import type { ActiveRuntimeBudget } from "@/lib/chat/active-runtime-budget";
import { AgentApprovalAuthorizationError } from "@/lib/chat/agent-approval-authorization";
import {
  AgentAutoReviewDenialTracker,
  reviewAgentToolAction,
  shouldAutoReviewAgentToolAction,
  type AgentAutoReviewDecision,
} from "@/lib/chat/agent-auto-review";

type TriggerSessionWaitResult<T> =
  { ok: true; output: T } | { ok: false; error?: unknown };

type TriggerSessionsApi = {
  open(idOrExternalId: string): {
    in: { wait<T>(): Promise<TriggerSessionWaitResult<T>> };
  };
};

const triggerSessions = (
  triggerSdk as unknown as { sessions?: TriggerSessionsApi }
).sessions;

type ApprovalUiStreamPart = Parameters<UIMessageStreamWriter["write"]>[0];

export type AgentApprovalRequesterSource = {
  runId: string;
  agentId?: string;
  agentName?: string;
};

const isAgentToolApprovalInputRecord = (
  value: unknown,
): value is AgentToolApprovalInputRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<AgentToolApprovalInputRecord>;
  return (
    record.type === "agent-tool-approval" &&
    record.protocolVersion === AGENT_TOOL_APPROVAL_PROTOCOL_VERSION &&
    typeof record.approvalId === "string" &&
    typeof record.toolCallId === "string" &&
    (record.decision === "approve" || record.decision === "deny") &&
    (record.grant === "full_access" || record.grant === "target_prefix") &&
    (record.targetPrefix === undefined ||
      typeof record.targetPrefix === "string") &&
    (record.targetKind === undefined ||
      record.targetKind === "terminal_command" ||
      record.targetKind === "terminal_interaction" ||
      record.targetKind === "file_change") &&
    (record.message === undefined || typeof record.message === "string") &&
    typeof record.authorization === "object" &&
    record.authorization !== null
  );
};

const isApprovalInputForRequest = (
  value: unknown,
  approvalId: string,
  toolCallId: string,
): boolean => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "agent-tool-approval" &&
    record.approvalId === approvalId &&
    record.toolCallId === toolCallId
  );
};

const APPROVAL_PROTOCOL_DENIED_REASON =
  "This approval response is incompatible with the current Agent worker. The operation was not run. Refresh HackerAI and start a new Agent request.";
const APPROVAL_AUTHORIZATION_DENIED_REASON =
  "Your authorization or billing access changed while this approval was pending. The operation was not run. Start a new Agent request and try again.";

export class AgentAutoReviewEntitlementRevalidationUnavailableError extends Error {
  constructor() {
    super("The current entitlement context could not be verified.");
    this.name = "AgentAutoReviewEntitlementRevalidationUnavailableError";
  }
}

const buildDeniedApprovalReason = (message: string | undefined): string => {
  const trimmed = message?.trim();
  if (!trimmed) return "The user denied approval for this operation.";
  return `The user denied approval for this operation and said: ${trimmed}`;
};

type AgentAutoReviewDecisionWithPhase = AgentAutoReviewDecision & {
  rolloutPhase: "shadow" | "enforce";
};

const buildAgentAutoReviewSummary = (
  autoReview: AgentAutoReviewDecisionWithPhase,
): AgentAutoReviewSummary => ({
  verdict: autoReview.verdict,
  riskCategory: autoReview.riskCategory,
  rationale: autoReview.rationale,
  rolloutPhase: autoReview.rolloutPhase,
  ...(autoReview.failureClass ? { failureClass: autoReview.failureClass } : {}),
});

const writeAgentAutoReviewLifecycle = ({
  writer,
  approvalId,
  toolCallId,
  status,
  startedAt,
}: {
  writer: UIMessageStreamWriter;
  approvalId: string;
  toolCallId: string;
  status: AgentAutoReviewLifecycleStatus;
  startedAt: number;
}): void => {
  writer.write({
    type: "data-agent-auto-review-lifecycle",
    data: {
      approvalId,
      toolCallId,
      status,
      startedAt,
      ...(status === "reviewing" ? {} : { completedAt: Date.now() }),
    },
  } as ApprovalUiStreamPart);
};

const buildPendingApprovalRequest = ({
  approvalId,
  request,
  autoReview,
  source,
}: {
  approvalId: string;
  request: AgentToolApprovalRequest;
  autoReview?: AgentAutoReviewDecisionWithPhase;
  source: AgentApprovalRequesterSource;
}): AgentToolApprovalPendingRequest => {
  const autoReviewSummary: AgentAutoReviewSummary | undefined =
    autoReview?.rolloutPhase === "enforce"
      ? buildAgentAutoReviewSummary(autoReview)
      : undefined;

  return {
    approvalId,
    toolCallId: request.toolCallId,
    sourceRunId: source.runId,
    ...(source.agentId ? { sourceAgentId: source.agentId } : {}),
    ...(source.agentName ? { sourceAgentName: source.agentName } : {}),
    operation: request.operation,
    target: request.target,
    ...(request.justification ? { justification: request.justification } : {}),
    ...(request.prefixRule ? { prefixRule: request.prefixRule } : {}),
    ...(autoReviewSummary ? { autoReview: autoReviewSummary } : {}),
    createdAt: Date.now(),
  };
};

type TriggerSessionInputWaitOutcome =
  | {
      status: "input";
      result: TriggerSessionWaitResult<AgentToolApprovalInputRecord>;
    }
  | { status: "aborted" };

const waitForApprovalInput = async (
  session: ReturnType<TriggerSessionsApi["open"]>,
  signal: AbortSignal,
): Promise<TriggerSessionInputWaitOutcome> => {
  if (signal.aborted) return { status: "aborted" };

  let removeAbortListener = () => {};
  const abortPromise = new Promise<TriggerSessionInputWaitOutcome>(
    (resolve) => {
      const abort = () => resolve({ status: "aborted" });
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
    },
  );

  try {
    return await Promise.race([
      session.in
        .wait<AgentToolApprovalInputRecord>()
        .then((result) => ({ status: "input", result }) as const),
      abortPromise,
    ]);
  } finally {
    removeAbortListener();
  }
};

type SandboxScopedAgentApprovalTargetGrant = {
  sandboxIdentity: AgentApprovalSandboxIdentity;
  workingDirectory?: string;
  grant: AgentApprovalTargetGrant;
};

const restoreSandboxScopedAgentApprovalTargetGrant = (
  grant: PersistedAgentApprovalTargetGrant,
  sandboxIdentity: AgentApprovalSandboxIdentity,
  workingDirectory?: string,
): AgentApprovalTargetGrant | null => {
  const targetPrefix = getAgentApprovalTargetPrefixForSandbox({
    persistedTargetPrefix: grant.targetPrefix,
    sandboxIdentity,
    workingDirectory,
  });
  return targetPrefix === null ? null : { ...grant, targetPrefix };
};

export const buildAgentToolApprovalRequester = ({
  agentPermissionMode,
  approvalSessionId,
  writer,
  chatId,
  userId,
  runId,
  source = { runId },
  signal,
  activeRuntimeBudget,
  initialTargetGrants = [],
  persistTargetGrant,
  resolveSandboxIdentity,
  workingDirectory,
  beforeSuspend,
  revalidateAfterSuspend,
  revalidateAfterAutoReview,
  autoReviewAssignment,
  autoReviewAuthorizationContext,
  autoReviewConversationContext,
  onAutoReviewCost,
  onAutoReviewCircuitBreaker,
  onPostWaitAuthorizationDenied,
  onApprovalWait,
}: {
  agentPermissionMode: AgentPermissionMode;
  approvalSessionId?: string;
  writer: UIMessageStreamWriter;
  chatId: string;
  userId: string;
  runId: string;
  source?: AgentApprovalRequesterSource;
  signal: AbortSignal;
  activeRuntimeBudget: Pick<ActiveRuntimeBudget, "pause" | "resume">;
  initialTargetGrants?: PersistedAgentApprovalTargetGrant[];
  persistTargetGrant?: (
    grant: PersistedAgentApprovalTargetGrant,
    sandboxIdentity: AgentApprovalSandboxIdentity,
  ) => Promise<void>;
  resolveSandboxIdentity: () => Promise<AgentApprovalSandboxIdentity>;
  workingDirectory?: string;
  beforeSuspend?: () => Promise<void>;
  revalidateAfterSuspend: (
    input: AgentToolApprovalInputRecord,
  ) => Promise<void>;
  revalidateAfterAutoReview: (input: {
    approvalId: string;
    toolCallId: string;
  }) => Promise<void>;
  autoReviewAssignment?: AgentAutoReviewAssignment;
  autoReviewAuthorizationContext: { text: string; complete: boolean };
  autoReviewConversationContext: { text: string; complete: boolean };
  onAutoReviewCost?: (costDollars: number) => void;
  onAutoReviewCircuitBreaker: () => void;
  onPostWaitAuthorizationDenied: () => void;
  onApprovalWait?: (durationMs: number, incrementCount: boolean) => void;
}): AgentToolApprovalRequester | undefined => {
  if (
    agentPermissionMode !== "ask_approval" &&
    agentPermissionMode !== "auto_review"
  ) {
    return undefined;
  }
  let approvalQueue: Promise<void> = Promise.resolve();
  const denialTracker = new AgentAutoReviewDenialTracker();
  const approvedTargetGrants: SandboxScopedAgentApprovalTargetGrant[] = [];
  const claimApprovalSlot = async (
    request: AgentToolApprovalPendingRequest,
  ): Promise<boolean> => {
    if (!approvalSessionId) return false;
    // The parent and its children share one durable Session inbox. Convex owns
    // the compare-and-set slot so only the action shown in the composer can
    // consume the next approval response.
    let retryDelaySeconds = 1;
    while (!signal.aborted) {
      try {
        const outcome = await setActiveAgentApprovalPending({
          chatId,
          pending: true,
          request,
          expectedRunId: runId,
          expectedApprovalSessionId: approvalSessionId,
        });
        if (outcome === "acquired") return true;
        if (outcome !== "busy") return false;
      } catch (error) {
        triggerLogger.error("[agent-approval] failed to claim approval slot", {
          chat_id: chatId,
          run_id: runId,
          source_run_id: source.runId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
        return false;
      }

      activeRuntimeBudget.pause();
      try {
        await wait.for({ seconds: retryDelaySeconds });
      } finally {
        activeRuntimeBudget.resume();
      }
      retryDelaySeconds = Math.min(5, retryDelaySeconds * 2);
    }
    return false;
  };
  const releaseApprovalSlot = async (approvalId: string): Promise<void> => {
    if (!approvalSessionId) return;
    try {
      await setActiveAgentApprovalPending({
        chatId,
        pending: false,
        expectedRunId: runId,
        expectedApprovalSessionId: approvalSessionId,
        expectedApprovalId: approvalId,
      });
    } catch (error) {
      triggerLogger.error("[agent-approval] failed to release approval slot", {
        chat_id: chatId,
        run_id: runId,
        source_run_id: source.runId,
        approval_id: approvalId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };

  return async (request: AgentToolApprovalRequest) => {
    const previousApproval = approvalQueue.catch(() => {});
    let releaseApproval!: () => void;
    approvalQueue = previousApproval.then(
      () =>
        new Promise<void>((resolve) => {
          releaseApproval = resolve;
        }),
    );

    await previousApproval;
    let approvalPendingMarked = false;
    let autoReviewDecision:
      | (AgentAutoReviewDecision & { rolloutPhase: "shadow" | "enforce" })
      | undefined;
    const approvalId = generateId();
    let autoReviewStartedAt: number | undefined;
    let autoReviewLifecycleCompleted = false;
    const completeAutoReviewLifecycle = (
      status: Exclude<AgentAutoReviewLifecycleStatus, "reviewing">,
    ) => {
      if (autoReviewStartedAt === undefined || autoReviewLifecycleCompleted) {
        return;
      }
      autoReviewLifecycleCompleted = true;
      writeAgentAutoReviewLifecycle({
        writer,
        approvalId,
        toolCallId: request.toolCallId,
        status,
        startedAt: autoReviewStartedAt,
      });
    };
    try {
      const sandboxIdentity = await resolveSandboxIdentity();
      const existingGrant =
        approvedTargetGrants.find(
          (scopedGrant) =>
            scopedGrant.sandboxIdentity === sandboxIdentity &&
            scopedGrant.workingDirectory === workingDirectory &&
            matchesApprovalTargetGrant(request, scopedGrant.grant),
        )?.grant ??
        initialTargetGrants
          .map((grant) =>
            restoreSandboxScopedAgentApprovalTargetGrant(
              grant,
              sandboxIdentity,
              workingDirectory,
            ),
          )
          .find(
            (grant): grant is AgentApprovalTargetGrant =>
              grant !== null && matchesApprovalTargetGrant(request, grant),
          );
      if (existingGrant) {
        metadata
          .set("approvalStatus", "auto_approved")
          .set("approvalToolName", request.toolName)
          .set("approvalOperation", request.operation);
        triggerLogger.info("[agent-long] tool approval reused", {
          event: "agent_tool_approval_reused",
          service: "agent-long",
          runId,
          source_run_id: source.runId,
          source_agent_id: source.agentId,
          approvalId,
          tool_call_id: request.toolCallId,
          tool_name: request.toolName,
          operation: request.operation,
          target_kind: existingGrant.kind,
        });
        return { approved: true, approvalId, sandboxIdentity };
      }

      const autoReviewRolloutPhase = autoReviewAssignment?.phase;
      if (
        autoReviewRolloutPhase &&
        shouldAutoReviewAgentToolAction({
          permissionMode: agentPermissionMode,
          rolloutPhase: autoReviewRolloutPhase,
          operation: request.operation,
        })
      ) {
        autoReviewStartedAt = Date.now();
        writeAgentAutoReviewLifecycle({
          writer,
          approvalId,
          toolCallId: request.toolCallId,
          status: "reviewing",
          startedAt: autoReviewStartedAt,
        });
        activeRuntimeBudget.pause();
        let decision: AgentAutoReviewDecision;
        try {
          decision = await reviewAgentToolAction({
            request,
            authorizationContext: autoReviewAuthorizationContext,
            conversationContext: autoReviewConversationContext,
            signal,
          });
        } finally {
          activeRuntimeBudget.resume();
        }
        autoReviewDecision = {
          ...decision,
          rolloutPhase: autoReviewRolloutPhase,
        };
        if (decision.modelCostDollars) {
          onAutoReviewCost?.(decision.modelCostDollars);
        }
        const reviewSurface =
          getAgentToolApprovalPromptKind(request.operation) ?? "file";
        phLogger.event("agent_auto_review_decision", {
          userId,
          rollout_phase: autoReviewRolloutPhase,
          verdict: decision.verdict,
          risk_category: decision.riskCategory,
          latency_ms: decision.latencyMs,
          failure_class: decision.failureClass ?? "none",
          outcome:
            autoReviewRolloutPhase === "shadow"
              ? "human_authoritative"
              : decision.verdict,
          surface: reviewSurface,
        });

        if (autoReviewRolloutPhase === "enforce") {
          if (decision.verdict === "approve") {
            try {
              await revalidateAfterAutoReview({
                approvalId,
                toolCallId: request.toolCallId,
              });
            } catch (error) {
              if (
                error instanceof
                AgentAutoReviewEntitlementRevalidationUnavailableError
              ) {
                autoReviewDecision = {
                  ...decision,
                  verdict: "ask_user",
                  riskCategory: "unknown",
                  rationale:
                    "HackerAI could not verify the current authorization context automatically.",
                  source: "failure",
                  failureClass: "provider_error",
                  rolloutPhase: autoReviewRolloutPhase,
                };
                metadata.set(
                  "approvalStatus",
                  "auto_review_revalidation_unavailable",
                );
                phLogger.event("agent_auto_review_revalidation", {
                  userId,
                  rollout_phase: autoReviewRolloutPhase,
                  verdict: "ask_user",
                  risk_category: "unknown",
                  failure_class: "provider_error",
                  outcome: "require_user",
                  surface: reviewSurface,
                });
                triggerLogger.warn(
                  "[agent-long] Auto review authorization revalidation unavailable; requesting human approval",
                  {
                    event: "agent_auto_review_revalidation_unavailable",
                    service: "agent-long",
                    chat_id: chatId,
                    user_id: userId,
                    run_id: runId,
                    approval_id: approvalId,
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                  },
                );
              } else {
                const authorizationError =
                  error instanceof AgentApprovalAuthorizationError
                    ? error
                    : null;
                metadata
                  .set("approvalStatus", "authorization_denied")
                  .set(
                    "approvalAuthorizationFailure",
                    authorizationError?.code ?? "revalidation_failed",
                  );
                triggerLogger.warn(
                  "[agent-long] post-review approval authorization denied",
                  {
                    chatId,
                    userId,
                    runId,
                    approvalId,
                    failure: authorizationError?.code ?? "revalidation_failed",
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                  },
                );
                return {
                  approved: false,
                  approvalId,
                  reason: APPROVAL_AUTHORIZATION_DENIED_REASON,
                };
              }
            }
            if (autoReviewDecision?.verdict === "approve") {
              const currentSandboxIdentity = await resolveSandboxIdentity();
              if (currentSandboxIdentity !== sandboxIdentity) {
                metadata.set("approvalStatus", "sandbox_changed");
                return {
                  approved: false,
                  approvalId,
                  reason:
                    "The selected sandbox changed during automatic review. The operation was not run. Retry it in the current sandbox.",
                };
              }
              metadata
                .set("approvalStatus", "auto_review_approved")
                .set("approvalToolName", request.toolName)
                .set("approvalOperation", request.operation);
              denialTracker.record("approve");
              completeAutoReviewLifecycle("approved");
              return {
                approved: true,
                approvalId,
                sandboxIdentity,
                approvalSource: "auto_review",
              };
            }
          }
          // A reviewer denial means the action is not safe to approve
          // automatically. It never substitutes for the user's decision;
          // continue into the durable human approval flow below.
        }
      }

      if (!approvalSessionId) {
        completeAutoReviewLifecycle("dismissed");
        return {
          approved: false,
          approvalId,
          reason:
            "Approval session is unavailable. Please retry the Agent run.",
        };
      }

      if (signal.aborted) {
        completeAutoReviewLifecycle("dismissed");
        metadata.set("approvalStatus", "aborted");
        return {
          approved: false,
          approvalId,
          reason: "The Agent run was stopped before approval was requested.",
        };
      }

      if (!triggerSessions) {
        completeAutoReviewLifecycle("dismissed");
        metadata.set("approvalStatus", "sessions_unavailable");
        return {
          approved: false,
          approvalId,
          reason:
            "Approval sessions are unavailable. Please retry the Agent run.",
        };
      }

      approvalPendingMarked = await claimApprovalSlot(
        buildPendingApprovalRequest({
          approvalId,
          request,
          autoReview: autoReviewDecision,
          source,
        }),
      );
      if (!approvalPendingMarked) {
        completeAutoReviewLifecycle("dismissed");
        metadata.set("approvalStatus", "approval_slot_unavailable");
        return {
          approved: false,
          approvalId,
          reason:
            "The Agent approval request is no longer active. Retry the action if the run is still open.",
        };
      }

      metadata
        .set("approvalStatus", "pending")
        .set("approvalId", approvalId)
        .set("approvalToolCallId", request.toolCallId)
        .set("approvalToolName", request.toolName)
        .set("approvalOperation", request.operation);
      await metadata.flush();

      completeAutoReviewLifecycle("needs_approval");

      if (autoReviewDecision?.rolloutPhase === "enforce") {
        const autoReview = buildAgentAutoReviewSummary(autoReviewDecision);
        writer.write({
          type: "data-agent-auto-review",
          data: {
            approvalId,
            toolCallId: request.toolCallId,
            autoReview,
          },
        } as ApprovalUiStreamPart);
      }

      writer.write({
        type: "tool-approval-request",
        toolCallId: request.toolCallId,
        approvalId,
      } as ApprovalUiStreamPart);

      triggerLogger.info("[agent-long] waiting for tool approval", {
        event: "agent_tool_approval_waiting",
        service: "agent-long",
        runId,
        source_run_id: source.runId,
        source_agent_id: source.agentId,
        approvalId,
        tool_call_id: request.toolCallId,
        tool_name: request.toolName,
        operation: request.operation,
      });

      const session = triggerSessions.open(approvalSessionId);
      if (beforeSuspend) {
        try {
          await beforeSuspend();
        } catch (error) {
          metadata.set("approvalStatus", "pre_suspend_check_failed");
          triggerLogger.warn(
            "[agent-long] approval suspension preparation failed",
            {
              chatId,
              userId,
              runId,
              approvalId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
          onPostWaitAuthorizationDenied();
          return {
            approved: false,
            approvalId,
            reason: APPROVAL_AUTHORIZATION_DENIED_REASON,
          };
        }
      }
      let approvalWaitCounted = false;
      while (!signal.aborted) {
        const approvalWaitStartedAt = Date.now();
        activeRuntimeBudget.pause();
        let waitOutcome: TriggerSessionInputWaitOutcome;
        try {
          waitOutcome = await waitForApprovalInput(session, signal);
        } finally {
          activeRuntimeBudget.resume();
          onApprovalWait?.(
            Date.now() - approvalWaitStartedAt,
            !approvalWaitCounted,
          );
          approvalWaitCounted = true;
        }
        if (waitOutcome.status === "aborted") break;

        const next = waitOutcome.result;
        if (!next.ok) {
          metadata.set("approvalStatus", "session_closed");
          return {
            approved: false,
            approvalId,
            reason: "The approval session closed before the tool could run.",
          };
        }

        if (!isAgentToolApprovalInputRecord(next.output)) {
          if (
            isApprovalInputForRequest(
              next.output,
              approvalId,
              request.toolCallId,
            )
          ) {
            metadata.set("approvalStatus", "unsupported_protocol");
            onPostWaitAuthorizationDenied();
            return {
              approved: false,
              approvalId,
              reason: APPROVAL_PROTOCOL_DENIED_REASON,
            };
          }
          continue;
        }
        if (
          next.output.approvalId !== approvalId ||
          next.output.toolCallId !== request.toolCallId
        ) {
          continue;
        }

        metadata
          .set("approvalStatus", next.output.decision)
          .set("approvalResolvedAt", Date.now());

        if (next.output.decision === "approve") {
          try {
            await revalidateAfterSuspend(next.output);
          } catch (error) {
            const authorizationError =
              error instanceof AgentApprovalAuthorizationError ? error : null;
            metadata
              .set("approvalStatus", "authorization_denied")
              .set(
                "approvalAuthorizationFailure",
                authorizationError?.code ?? "revalidation_failed",
              );
            triggerLogger.warn(
              "[agent-long] post-wait approval authorization denied",
              {
                chatId,
                userId,
                runId,
                approvalId,
                failure: authorizationError?.code ?? "revalidation_failed",
                error_name:
                  error instanceof Error ? error.name : "UnknownError",
              },
            );
            onPostWaitAuthorizationDenied();
            return {
              approved: false,
              approvalId,
              reason:
                authorizationError?.code === "unsupported_protocol"
                  ? APPROVAL_PROTOCOL_DENIED_REASON
                  : APPROVAL_AUTHORIZATION_DENIED_REASON,
            };
          }

          const currentSandboxIdentity = await resolveSandboxIdentity();
          if (currentSandboxIdentity !== sandboxIdentity) {
            metadata.set("approvalStatus", "sandbox_changed");
            triggerLogger.warn(
              "[agent-long] sandbox changed while approval was pending",
              {
                chatId,
                userId,
                runId,
                approvalId,
                requested_sandbox_identity: sandboxIdentity,
                current_sandbox_identity: currentSandboxIdentity,
              },
            );
            return {
              approved: false,
              approvalId,
              reason:
                "The selected sandbox changed while this approval was pending. The operation was not run. Retry it to approve in the current sandbox.",
            };
          }

          const approvedTargetGrant =
            next.output.grant === "target_prefix"
              ? deriveApprovedAgentTargetGrant(request, next.output)
              : null;
          if (approvedTargetGrant) {
            approvedTargetGrants.push({
              sandboxIdentity,
              workingDirectory,
              grant: approvedTargetGrant,
            });
            if (
              persistTargetGrant &&
              approvedTargetGrant.kind !== "terminal_interaction"
            ) {
              try {
                await persistTargetGrant(approvedTargetGrant, sandboxIdentity);
              } catch (error) {
                triggerLogger.warn(
                  "[agent-long] failed to persist approval grant",
                  {
                    chatId,
                    userId,
                    runId,
                    approvalId,
                    target_kind: approvedTargetGrant.kind,
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                  },
                );
              }
            }
            metadata
              .set("approvalGrant", "target_prefix")
              .set("approvalTargetKind", approvedTargetGrant.kind);
          }
          triggerLogger.info("[agent-long] tool approval granted", {
            event: "agent_tool_approval_granted",
            service: "agent-long",
            runId,
            source_run_id: source.runId,
            source_agent_id: source.agentId,
            approvalId,
            tool_call_id: request.toolCallId,
            tool_name: request.toolName,
            operation: request.operation,
            requested_grant: next.output.grant,
            grant: approvedTargetGrant ? "target_prefix" : "full_access",
            target_kind: approvedTargetGrant?.kind,
          });
          if (autoReviewDecision) {
            phLogger.event("agent_auto_review_human_outcome", {
              userId,
              rollout_phase: autoReviewDecision.rolloutPhase,
              verdict: autoReviewDecision.verdict,
              risk_category: autoReviewDecision.riskCategory,
              failure_class: autoReviewDecision.failureClass ?? "none",
              outcome: "approve",
              override: autoReviewDecision.verdict === "deny",
              surface:
                getAgentToolApprovalPromptKind(request.operation) ?? "file",
            });
          }
          if (autoReviewDecision?.rolloutPhase === "enforce") {
            denialTracker.record("approve");
          }
          return { approved: true, approvalId, sandboxIdentity };
        }

        triggerLogger.info("[agent-long] tool approval denied", {
          event: "agent_tool_approval_denied",
          service: "agent-long",
          runId,
          source_run_id: source.runId,
          source_agent_id: source.agentId,
          approvalId,
          tool_call_id: request.toolCallId,
          tool_name: request.toolName,
          operation: request.operation,
        });
        if (autoReviewDecision) {
          phLogger.event("agent_auto_review_human_outcome", {
            userId,
            rollout_phase: autoReviewDecision.rolloutPhase,
            verdict: autoReviewDecision.verdict,
            risk_category: autoReviewDecision.riskCategory,
            failure_class: autoReviewDecision.failureClass ?? "none",
            outcome: "deny",
            override: autoReviewDecision.verdict === "approve",
            surface:
              getAgentToolApprovalPromptKind(request.operation) ?? "file",
          });
        }
        const humanDenialTrippedCircuitBreaker =
          autoReviewDecision?.rolloutPhase === "enforce" &&
          denialTracker.record("deny").tripped;
        if (humanDenialTrippedCircuitBreaker && autoReviewDecision) {
          metadata.set("approvalStatus", "auto_review_circuit_breaker");
          phLogger.event("agent_auto_review_circuit_breaker", {
            userId,
            rollout_phase: autoReviewDecision.rolloutPhase,
            verdict: autoReviewDecision.verdict,
            risk_category: autoReviewDecision.riskCategory,
            outcome: "require_user",
            surface:
              getAgentToolApprovalPromptKind(request.operation) ?? "file",
          });
          onAutoReviewCircuitBreaker();
        }
        return {
          approved: false,
          approvalId,
          reason: humanDenialTrippedCircuitBreaker
            ? `${buildDeniedApprovalReason(next.output.message)} The denial circuit breaker stopped further approval attempts in this run.`
            : buildDeniedApprovalReason(next.output.message),
        };
      }

      metadata.set("approvalStatus", "aborted");
      return {
        approved: false,
        approvalId,
        reason: "The Agent run was stopped before approval was received.",
      };
    } finally {
      completeAutoReviewLifecycle("dismissed");
      if (approvalPendingMarked) {
        await releaseApprovalSlot(approvalId);
      }
      releaseApproval();
    }
  };
};
