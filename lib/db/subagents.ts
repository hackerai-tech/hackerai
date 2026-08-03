import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./convex-client";
import type {
  SecurityValidationCandidate,
  SecurityValidationResult,
  SubagentContextRef,
  SubagentStatus,
  ValidationConfidence,
  VulnerabilityReportInput,
} from "@/lib/ai/subagents/contracts";
import type { SubscriptionTier } from "@/types/chat";

const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

export type PersistedSubagent = {
  subagent_id: string;
  user_id: string;
  organization_id?: string;
  chat_id: string;
  parent_message_id: string;
  parent_tool_call_id: string;
  parent_trigger_run_id: string;
  trigger_run_id?: string;
  profile: "security_validation";
  depth: number;
  status: SubagentStatus;
  objective: string;
  candidate: SecurityValidationCandidate;
  candidate_fingerprint: string;
  context_refs: SubagentContextRef[];
  sandbox_preference?: string;
  sandbox_identity?: string;
  permission_mode?: string;
  selected_model?: string;
  subscription: SubscriptionTier;
  free_quota_subject?: string;
  user_location?: unknown;
  summary?: string;
  verdict?: SecurityValidationResult["verdict"];
  confidence?: ValidationConfidence;
  structured_result?: SecurityValidationResult;
  failure_code?: string;
  failure_reason?: string;
  cancel_reason?: string;
  acknowledged_by_parent_run_id?: string;
  report_id?: string;
  cost_limit_dollars: number;
  cost_dollars?: number;
  step_count?: number;
  provider_retry_count?: number;
  result_recovery_count?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  updated_at: number;
};

export const reserveSubagent = async (args: {
  subagentId: string;
  userId: string;
  organizationId?: string;
  chatId: string;
  parentMessageId: string;
  parentToolCallId: string;
  parentTriggerRunId: string;
  objective: string;
  candidate: SecurityValidationCandidate;
  candidateFingerprint: string;
  contextRefs: SubagentContextRef[];
  sandboxPreference?: string;
  sandboxIdentity?: string;
  permissionMode?: string;
  selectedModel?: string;
  subscription: SubscriptionTier;
  freeQuotaSubject?: string;
  userLocation?: unknown;
}) =>
  await getConvexClient().mutation(api.subagents.reserveForBackend, {
    serviceKey,
    ...args,
  });

export const getSubagent = async (
  subagentId: string,
): Promise<PersistedSubagent | null> =>
  (await getConvexClient().query(api.subagents.getForBackend, {
    serviceKey,
    subagentId,
  })) as PersistedSubagent | null;

export const listActiveSubagentsForParent = async (
  parentTriggerRunId: string,
): Promise<PersistedSubagent[]> =>
  (await getConvexClient().query(api.subagents.listActiveForParentBackend, {
    serviceKey,
    parentTriggerRunId,
  })) as PersistedSubagent[];

export const getOwnedSubagent = async (
  subagentId: string,
  userId: string,
): Promise<PersistedSubagent> =>
  (await getConvexClient().query(api.subagents.requireOwnedForBackend, {
    serviceKey,
    subagentId,
    userId,
  })) as PersistedSubagent;

export const resolveSubagentContext = async (
  subagentId: string,
): Promise<Array<{ label: string; content: string }>> =>
  (await getConvexClient().query(api.subagents.resolveContextForBackend, {
    serviceKey,
    subagentId,
  })) as Array<{ label: string; content: string }>;

export const attachSubagentTriggerRun = async (
  subagentId: string,
  triggerRunId: string,
) =>
  await getConvexClient().mutation(api.subagents.attachTriggerRunForBackend, {
    serviceKey,
    subagentId,
    triggerRunId,
  });

export const markSubagentFinalizing = async (
  subagentId: string,
  triggerRunId: string,
) =>
  await getConvexClient().mutation(api.subagents.markFinalizingForBackend, {
    serviceKey,
    subagentId,
    triggerRunId,
  });

export const cancelSubagentForUser = async (args: {
  subagentId: string;
  userId: string;
  triggerRunId?: string;
  reason: string;
}) =>
  await getConvexClient().mutation(api.subagents.cancelForBackend, {
    serviceKey,
    ...args,
  });

export const failUnattachedSubagent = async (args: {
  subagentId: string;
  parentTriggerRunId: string;
  failureCode: string;
  summary: string;
}) =>
  await getConvexClient().mutation(api.subagents.failUnattachedForBackend, {
    serviceKey,
    ...args,
  });

export const recordSubagentRecovery = async (args: {
  subagentId: string;
  triggerRunId: string;
  kind: "provider_retry" | "result_recovery";
}) =>
  await getConvexClient().mutation(api.subagents.recordRecoveryForBackend, {
    serviceKey,
    ...args,
  });

export const cancelSubagentsForParent = async (
  parentTriggerRunId: string,
  reason: string,
) =>
  await getConvexClient().mutation(api.subagents.cancelForParentBackend, {
    serviceKey,
    parentTriggerRunId,
    reason,
  });

export const cancelSubagentsForChatDeletion = async (
  chatId: string,
  userId: string,
  reason: string,
) =>
  await getConvexClient().mutation(api.subagents.cancelForChatDeletionBackend, {
    serviceKey,
    chatId,
    userId,
    reason,
  });

export const cancelSubagentsForUserDeletion = async (
  userId: string,
  reason: string,
) =>
  await getConvexClient().mutation(api.subagents.cancelForUserDeletionBackend, {
    serviceKey,
    userId,
    reason,
  });

export const finishSubagent = async (args: {
  subagentId: string;
  triggerRunId: string;
  status: "completed" | "failed" | "canceled" | "timed_out";
  summary: string;
  verdict?: SecurityValidationResult["verdict"];
  confidence?: ValidationConfidence;
  structuredResult?: SecurityValidationResult;
  failureCode?: string;
  failureReason?: string;
  cancelReason?: string;
  costDollars?: number;
  stepCount?: number;
}) =>
  await getConvexClient().mutation(api.subagents.finishForBackend, {
    serviceKey,
    ...args,
  });

export const acknowledgeSubagentResult = async (
  subagentId: string,
  parentTriggerRunId: string,
) =>
  await getConvexClient().mutation(api.subagents.acknowledgeForBackend, {
    serviceKey,
    subagentId,
    parentTriggerRunId,
  });

export const saveSubagentMessage = async (args: {
  subagentId: string;
  userId: string;
  sequence: number;
  role: "user" | "assistant" | "system";
  parts: unknown[];
}) =>
  await getConvexClient().mutation(api.subagents.saveMessageForBackend, {
    serviceKey,
    ...args,
  });

export const promoteVulnerabilityReport = async (args: {
  userId: string;
  chatId: string;
  parentTriggerRunId: string;
  input: VulnerabilityReportInput;
}) =>
  await getConvexClient().mutation(api.vulnerabilityReports.promoteForBackend, {
    serviceKey,
    userId: args.userId,
    chatId: args.chatId,
    parentTriggerRunId: args.parentTriggerRunId,
    validationId: args.input.validation_id,
    title: args.input.title,
    affectedAsset: args.input.affected_asset,
    weaknessClass: args.input.weakness_class,
    severity: args.input.severity,
    description: args.input.description,
    technicalAnalysis: args.input.technical_analysis,
    reproductionSteps: args.input.reproduction_steps,
    impact: args.input.impact,
    remediation: args.input.remediation,
    evidenceRefs: args.input.evidence_refs,
    confidence: args.input.confidence,
  });
