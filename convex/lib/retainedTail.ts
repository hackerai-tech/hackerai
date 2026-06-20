import { v } from "convex/values";

export const retainedTailValidator = v.object({
  start_message_id: v.string(),
  start_part_index: v.number(),
  budget_tokens: v.number(),
  retained_tokens: v.number(),
  retained_message_count: v.number(),
  retained_part_count: v.number(),
  projected_part_count: v.number(),
  strategy: v.literal("token_budgeted_tail_v1"),
});

export type RetainedTailDoc = {
  start_message_id: string;
  start_part_index: number;
  budget_tokens: number;
  retained_tokens: number;
  retained_message_count: number;
  retained_part_count: number;
  projected_part_count: number;
  strategy: "token_budgeted_tail_v1";
};
