import { v } from "convex/values";

export const userInputQuestionsValidator = v.array(
  v.object({
    id: v.string(),
    header: v.string(),
    question: v.string(),
    options: v.array(
      v.object({
        label: v.string(),
        value: v.string(),
        description: v.optional(v.string()),
      }),
    ),
    multiSelect: v.optional(v.boolean()),
    allowCustomAnswer: v.optional(v.boolean()),
  }),
);
