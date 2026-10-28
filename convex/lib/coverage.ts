import { v } from "convex/values";

export const coverageEntryValidator = v.object({
  surface: v.string(),
  riskArea: v.string(),
  outcome: v.union(
    v.literal("investigating"),
    v.literal("needs_follow_up"),
    v.literal("ruled_out"),
    v.literal("confirmed"),
  ),
  hypothesis: v.string(),
  evidenceFor: v.string(),
  evidenceAgainst: v.string(),
  missingProof: v.string(),
  nextTest: v.string(),
  updatedAt: v.number(),
});
