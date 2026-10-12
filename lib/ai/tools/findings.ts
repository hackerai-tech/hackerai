import { tool } from "ai";
import type { AnySandbox, ToolContext } from "@/types";
import {
  evidenceFilePath,
  verifyEvidenceReferences,
} from "@/lib/ai/subagents/evidence-references";
import { getSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import type { EvidenceVerification } from "@/lib/ai/subagents/contracts";
import {
  createFinding,
  listReports,
  getReport,
  updateFinding,
} from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";
import {
  listReportsTool,
  getReportTool,
  updateVulnerabilityReportTool,
  type ListReportsInput,
  type GetReportInput,
  type UpdateVulnerabilityReportToolInput,
  createVulnerabilityReportTool,
  type CreateVulnerabilityReportInput,
} from "./schemas";

async function prepareFindingEvidence<T extends { evidence_refs?: string[] }>(
  input: T,
  getCurrentSandbox: () => AnySandbox | null,
  abortSignal?: AbortSignal,
) {
  let report = input;
  let evidenceVerification: EvidenceVerification | undefined;
  const refs = input.evidence_refs ?? [];
  const fileRefs = refs.filter((ref) => evidenceFilePath(ref) !== undefined);
  if (fileRefs.length) {
    // Only inspect the sandbox already acquired by this authorized run.
    // getSandbox/ensureSandbox could boot or switch environments here.
    const sandbox = getCurrentSandbox();
    if (!sandbox) {
      evidenceVerification = {
        checked_refs: [],
        unavailable_refs: fileRefs,
        warning:
          "Saved evidence could not be checked because this run has no connected sandbox. The report is preserved; these references remain unverified. File existence does not establish vulnerability validity.",
      };
      report = {
        ...input,
        evidence_refs: refs.filter((ref) => !fileRefs.includes(ref)),
      };
    } else {
      const checked = await verifyEvidenceReferences({
        refs,
        sandbox,
        expectedSandboxIdentity: getSubagentSandboxIdentity(sandbox),
        signal: abortSignal ?? new AbortController().signal,
        authorize: async () => {
          abortSignal?.throwIfAborted();
          if (getCurrentSandbox() !== sandbox) {
            throw new Error("The selected evidence sandbox changed.");
          }
        },
      });
      if (!checked.accepted) {
        return { accepted: false as const, error: checked.error };
      }
      report = { ...input, evidence_refs: checked.evidence_refs };
      evidenceVerification = checked.evidence_verification;
    }
  }

  return { accepted: true as const, report, evidenceVerification };
}

export const createCreateVulnerabilityReport = (
  context: ToolContext,
  getCurrentSandbox: () => AnySandbox | null = () => null,
) =>
  tool({
    ...createVulnerabilityReportTool,
    execute: async (
      input: CreateVulnerabilityReportInput,
      { toolCallId, abortSignal },
    ) => {
      if (!context.assistantMessageId) {
        return {
          success: false as const,
          error: "general" as const,
          retryable: false as const,
          message:
            "Finding provenance is unavailable. The report was not saved.",
        };
      }

      try {
        abortSignal?.throwIfAborted();
        const prepared = await prepareFindingEvidence(
          input,
          getCurrentSandbox,
          abortSignal,
        );
        if (!prepared.accepted)
          return {
            success: false as const,
            error: "validation" as const,
            validation_kind: "evidence" as const,
            retryable: false as const,
            message: prepared.error,
          };
        const { report, evidenceVerification } = prepared;
        abortSignal?.throwIfAborted();
        const result = await createFinding({
          userId: context.userID,
          chatId: context.chatId,
          messageId: context.assistantMessageId,
          toolCallId,
          report,
          ...(evidenceVerification ? { evidenceVerification } : {}),
        });

        if (!result.success && result.error === "duplicate") {
          phLogger.event("finding_duplicate_rejected", {
            userId: context.userID,
          });
        } else if (result.success) {
          phLogger.event("finding_created", { userId: context.userID });
        }

        return result;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        console.error("Create vulnerability report tool failed", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        return {
          success: false as const,
          error: "general" as const,
          retryable: true as const,
          message:
            "The finding could not be saved. Retry the same report once.",
        };
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });

export const createListReports = (context: ToolContext) =>
  tool({
    ...listReportsTool,
    execute: async (
      { limit, cursor, search, status }: ListReportsInput,
      { abortSignal },
    ) => {
      try {
        abortSignal?.throwIfAborted();
        const result = await listReports({
          userId: context.userID,
          chatId: context.chatId,
          limit,
          cursor: cursor ?? null,
          search,
          status,
        });
        abortSignal?.throwIfAborted();
        return result;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        return {
          success: false as const,
          error: "general" as const,
          message: "Reports could not be listed. Try again later.",
        };
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });

export const createGetReport = (context: ToolContext) =>
  tool({
    ...getReportTool,
    execute: async ({ finding_id }: GetReportInput, { abortSignal }) => {
      try {
        abortSignal?.throwIfAborted();
        const result = await getReport({
          userId: context.userID,
          chatId: context.chatId,
          findingId: finding_id,
        });
        abortSignal?.throwIfAborted();
        return result;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        return {
          success: false as const,
          error: "general" as const,
          message: "The report could not be read. Try again later.",
        };
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });

export const createUpdateVulnerabilityReport = (
  context: ToolContext,
  getCurrentSandbox: () => AnySandbox | null = () => null,
) =>
  tool({
    ...updateVulnerabilityReportTool,
    execute: async (
      input: UpdateVulnerabilityReportToolInput,
      { toolCallId, abortSignal },
    ) => {
      if (!context.assistantMessageId)
        return {
          success: false as const,
          error: "general" as const,
          retryable: false as const,
          message:
            "Update provenance is unavailable. The report was not changed.",
        };
      try {
        abortSignal?.throwIfAborted();
        // Authorize the report before inspecting any model-supplied capture path.
        const current = await getReport({
          userId: context.userID,
          chatId: context.chatId,
          findingId: input.finding_id,
        });
        if (!current.success) return current;
        if (current.report.updated_at !== input.expected_updated_at)
          return {
            success: false as const,
            error: "conflict" as const,
            retryable: false as const,
            message:
              "The report changed. Read it again and reconcile before updating.",
          };
        let changes = input.changes;
        let evidenceVerification: EvidenceVerification | undefined;
        if (Object.hasOwn(changes, "evidence_refs")) {
          const prepared = await prepareFindingEvidence(
            changes,
            getCurrentSandbox,
            abortSignal,
          );
          if (!prepared.accepted)
            return {
              success: false as const,
              error: "validation" as const,
              validation_kind: "evidence" as const,
              retryable: false as const,
              message: prepared.error,
            };
          changes = prepared.report;
          evidenceVerification = prepared.evidenceVerification;
        }
        abortSignal?.throwIfAborted();
        const result = await updateFinding({
          userId: context.userID,
          chatId: context.chatId,
          messageId: context.assistantMessageId,
          toolCallId,
          update: { ...input, changes },
          ...(evidenceVerification ? { evidenceVerification } : {}),
        });
        if (result.success)
          phLogger.event("finding_updated", { userId: context.userID });
        return result;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        console.error("Update vulnerability report tool failed", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        return {
          success: false as const,
          error: "general" as const,
          retryable: false as const,
          message:
            "The update response could not be confirmed. Read the report again before retrying; it may already be saved.",
        };
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });
