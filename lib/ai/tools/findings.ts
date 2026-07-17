import { tool } from "ai";
import type { ToolContext } from "@/types";
import { createFinding } from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";
import {
  createVulnerabilityReportTool,
  type CreateVulnerabilityReportInput,
} from "./schemas";

export const createCreateVulnerabilityReport = (context: ToolContext) =>
  tool({
    ...createVulnerabilityReportTool,
    execute: async (input: CreateVulnerabilityReportInput, { toolCallId }) => {
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
        const result = await createFinding({
          userId: context.userID,
          chatId: context.chatId,
          messageId: context.assistantMessageId,
          toolCallId,
          report: input,
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
