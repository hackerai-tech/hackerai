import { v } from "convex/values";

const severity = v.union(
  v.literal("critical"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("info"),
);
const confidence = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export const findingRevisionValidator = v.object({
  updated_at: v.number(),
  message_id: v.string(),
  reason: v.string(),
  changed_fields: v.array(v.string()),
  previous_severity: severity,
  severity: severity,
  previous_cvss_score: v.number(),
  cvss_score: v.number(),
  previous_confidence: v.optional(confidence),
  confidence: v.optional(confidence),
});
export const findingFeedbackAnswerValidator = v.union(
  v.literal("useful"),
  v.literal("needs_correction"),
  v.literal("not_checked"),
);
export const findingFeedbackValidator = v.object({
  answer: findingFeedbackAnswerValidator,
  report_updated_at: v.number(),
  submitted_at: v.number(),
});
