import { tool } from "ai";
import type { ToolContext } from "@/types";
import { isHttpFindingRetestsEnabled } from "@/lib/findings/http-retest-policy";
import {
  getHttpRetestState,
  saveHttpRetestRecipe,
} from "@/lib/findings/http-retest-service";
import {
  getHttpRetestRecipeTool,
  saveHttpRetestRecipeTool,
  type GetHttpRetestRecipeInput,
  type SaveHttpRetestRecipeInput,
} from "./schemas";

const unavailable = {
  success: false as const,
  error: "unavailable" as const,
  message: "Executable retests are not available for this account.",
};

const failed = {
  success: false as const,
  error: "general" as const,
  message: "The retest recipe could not be reached. Try again later.",
};

/**
 * Agent tools may read and save recipes for reports in the current chat only.
 * They can never start a run: execution is always a deliberate user action.
 */
export const createGetHttpRetestRecipe = (context: ToolContext) =>
  tool({
    ...getHttpRetestRecipeTool,
    execute: async (
      { finding_id }: GetHttpRetestRecipeInput,
      { abortSignal },
    ) => {
      try {
        if (!(await isHttpFindingRetestsEnabled(context.userID)))
          return unavailable;
        abortSignal?.throwIfAborted();
        const state = await getHttpRetestState({
          userId: context.userID,
          findingId: finding_id,
          chatId: context.chatId,
        });
        if (!state.available)
          return {
            success: false as const,
            error: "not_found" as const,
            message: "The report is not available in this chat.",
          };
        return {
          success: true as const,
          version: state.recipe?.version ?? 0,
          recipe: state.recipe?.recipe ?? null,
          recent_runs: state.runs.map((run) => ({
            status: run.status,
            outcome: run.outcome ?? null,
            reason: run.reason ?? null,
            recipe_version: run.recipe_version,
            started_at: run.started_at,
          })),
        };
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        return failed;
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });

export const createSaveHttpRetestRecipe = (context: ToolContext) =>
  tool({
    ...saveHttpRetestRecipeTool,
    execute: async (
      { finding_id, expected_version, recipe }: SaveHttpRetestRecipeInput,
      { abortSignal },
    ) => {
      try {
        if (!(await isHttpFindingRetestsEnabled(context.userID)))
          return unavailable;
        abortSignal?.throwIfAborted();
        const result = await saveHttpRetestRecipe({
          userId: context.userID,
          findingId: finding_id,
          chatId: context.chatId,
          expectedVersion: expected_version,
          recipe,
          source: "agent",
        });
        return result.success
          ? {
              ...result,
              message:
                "Saved. The user can review and run it from the report; nothing was sent.",
            }
          : result;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        return failed;
      }
    },
    toModelOutput({ output }) {
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });
