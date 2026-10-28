import { tool } from "ai";
import { ConvexError } from "convex/values";
import { writeAgentCoverage } from "@/lib/db/actions";
import { coverageKey, type CoverageEntry } from "@/lib/ai/coverage-ledger";
import { coverageReadTool, coverageWriteTool } from "./schemas";

export const createCoverageWrite = (args: {
  userId: string;
  chatId: string;
  runId: string;
  onSaved: (entries: CoverageEntry[]) => void;
}) =>
  tool({
    ...coverageWriteTool,
    execute: async (entry) => {
      try {
        const saved = await writeAgentCoverage({
          userId: args.userId,
          chatId: args.chatId,
          runId: args.runId,
          entry,
        });
        args.onSaved(saved);
        return {
          success: true,
          entry: saved.find((row) => coverageKey(row) === coverageKey(entry)),
          total: saved.length,
        };
      } catch (error) {
        const data =
          error instanceof ConvexError &&
          error.data &&
          typeof error.data === "object" &&
          !Array.isArray(error.data)
            ? (error.data as { code?: unknown })
            : null;
        const reason =
          data?.code === "COVERAGE_FULL"
            ? "Coverage is full. Update an existing surface and risk instead."
            : data?.code === "VALIDATION_ERROR"
              ? "Coverage fields are invalid. Check the required evidence for this outcome."
              : data?.code === "COVERAGE_RUN_INACTIVE"
                ? "This Agent run is no longer active; stop writing coverage."
                : "Coverage could not be saved. The working record was not updated.";
        return {
          success: false,
          error: reason,
        };
      }
    },
  });

export const createCoverageRead = (getEntries: () => CoverageEntry[]) =>
  tool({
    ...coverageReadTool,
    execute: async () => ({ entries: getEntries() }),
  });
