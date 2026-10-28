import { tool } from "ai";
import { writeAgentCoverage } from "@/lib/db/actions";
import type { CoverageEntry } from "@/lib/ai/coverage-ledger";
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
          entry: saved.find(
            (row) =>
              row.surface.toLowerCase() === entry.surface.toLowerCase() &&
              row.riskArea.toLowerCase() === entry.riskArea.toLowerCase(),
          ),
          total: saved.length,
        };
      } catch {
        return {
          success: false,
          error:
            "Coverage could not be saved. The working record was not updated.",
        };
      }
    },
  });

export const createCoverageRead = (getEntries: () => CoverageEntry[]) =>
  tool({
    ...coverageReadTool,
    execute: async () => ({ entries: getEntries() }),
  });
