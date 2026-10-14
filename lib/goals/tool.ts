import { tool } from "ai";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { goalServiceKey } from "./server";

export function createGoalCheckpointTool(
  chatId: string,
  userId: string,
  runId: string,
) {
  return tool({
    description:
      "Save persistent goal progress and proposed outcome. Call before ending every goal turn. For each verified success criterion use its zero-based index and an executed toolCallId, or toolName to reference its most recent result in this run, and explain how that result proves the criterion. Completion is independently checked against saved tool results after settlement. Use needs_input for missing permission or information; blocked for a demonstrated blocker; continue for unfinished useful work; wait with waitSeconds for an authorized bounded delay. Never achieved merely at a runtime, step, context, usage or spend limit.",
    inputSchema: z.object({
      outcome: z.enum([
        "continue",
        "achieved",
        "needs_input",
        "blocked",
        "wait",
      ]),
      waitSeconds: z.number().int().min(1).max(1800).optional(),
      progress: z.string().trim().min(1).max(4000),
      evidence: z
        .array(
          z
            .object({
              criterion: z.number().int().min(0).max(7),
              toolCallId: z.string().min(1).max(200).optional(),
              toolName: z.string().min(1).max(128).optional(),
              explanation: z.string().trim().min(1).max(1000),
            })
            .refine(
              (e) => !!e.toolCallId || !!e.toolName,
              "Reference an executed tool by ID or name",
            ),
        )
        .max(8),
    }),
    execute: async (
      { outcome, progress, evidence, waitSeconds },
      { messages },
    ) => {
      const results = messages.flatMap((message) =>
        message.role === "tool"
          ? message.content.filter((part) => part.type === "tool-result")
          : [],
      );
      const resolved = evidence.map((e) => {
        const result = results
          .slice()
          .reverse()
          .find((r) =>
            e.toolCallId
              ? r.toolCallId === e.toolCallId
              : r.toolName === e.toolName,
          );
        if (!result)
          throw new Error(
            "Goal evidence must reference a completed tool result in this run.",
          );
        return {
          criterion: e.criterion,
          explanation: e.explanation,
          toolCallId: result.toolCallId,
          runId,
        };
      });
      const saved = await getConvexClient().mutation(
        api.agentGoals.checkpoint,
        {
          serviceKey: goalServiceKey(),
          chatId,
          userId,
          runId,
          checkpoint: {
            outcome,
            ...(waitSeconds ? { waitSeconds } : {}),
            progress,
            evidence: resolved,
          },
        },
      );
      return {
        saved,
        completionPendingValidation: outcome === "achieved" && saved,
      };
    },
  });
}
