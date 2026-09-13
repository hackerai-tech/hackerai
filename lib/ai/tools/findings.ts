import { tool } from "ai";
import type { AnySandbox, ToolContext } from "@/types";
import {
  evidenceFilePath,
  verifyEvidenceReferences,
} from "@/lib/ai/subagents/evidence-references";
import { getSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import type { EvidenceVerification } from "@/lib/ai/subagents/contracts";
import { createFinding } from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";
import {
  createVulnerabilityReportTool,
  type CreateVulnerabilityReportInput,
} from "./schemas";

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
        let report = input;
        let evidenceVerification: EvidenceVerification | undefined;
        const refs = input.evidence_refs ?? [];
        const fileRefs = refs.filter(
          (ref) => evidenceFilePath(ref) !== undefined,
        );
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
              return {
                success: false as const,
                error: "validation" as const,
                retryable: false as const,
                message: checked.error,
              };
            }
            report = { ...input, evidence_refs: checked.evidence_refs };
            evidenceVerification = checked.evidence_verification;
          }
        }
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
