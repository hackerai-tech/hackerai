import { v } from "convex/values";

export const researchConfidenceValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export const researchUserTypeValidator = v.union(
  v.literal("bug_bounty_hunter"),
  v.literal("solo_pentester"),
  v.literal("security_student"),
  v.literal("security_engineer"),
  v.literal("software_developer"),
  v.literal("security_researcher"),
  v.literal("automation_builder"),
  v.literal("mixed"),
  v.literal("unknown"),
);

export const researchPatternValidator = v.object({
  label: v.string(),
  description: v.string(),
  evidenceCount: v.number(),
  confidence: researchConfidenceValidator,
});

export const researchUserTypeEvidenceValidator = v.object({
  type: researchUserTypeValidator,
  evidenceCount: v.number(),
  confidence: researchConfidenceValidator,
});

export const researchUserProfileValidator = v.object({
  summary: v.string(),
  userTypes: v.array(researchUserTypeEvidenceValidator),
  declaredContext: v.union(v.string(), v.null()),
  recurringJobs: v.array(researchPatternValidator),
  workflowPatterns: v.array(researchPatternValidator),
  toolsAndEnvironments: v.array(researchPatternValidator),
  valueDrivers: v.array(researchPatternValidator),
  frictionAndUnmetNeeds: v.array(researchPatternValidator),
  reasonsToPay: v.array(researchPatternValidator),
  confidence: researchConfidenceValidator,
  uncertainty: v.array(v.string()),
});

export const researchCoverageValidator = v.object({
  chatsReviewed: v.number(),
  messagesReviewed: v.number(),
  askChats: v.number(),
  agentChats: v.number(),
  firstActivityAt: v.optional(v.number()),
  lastActivityAt: v.optional(v.number()),
  truncatedChats: v.number(),
});

export const researchAvatarValidator = v.object({
  name: v.string(),
  definition: v.string(),
  mainJob: v.string(),
  supportingUserTypes: v.array(researchUserTypeValidator),
  pains: v.array(v.string()),
  desiredOutcomes: v.array(v.string()),
  reasonsToPay: v.array(v.string()),
  productFeatures: v.array(v.string()),
  objectionsAndTrustNeeds: v.array(v.string()),
  acquisitionHypotheses: v.array(v.string()),
  messageHypotheses: v.array(v.string()),
  evidenceUserCount: v.number(),
  confidence: researchConfidenceValidator,
});

export const researchExperimentValidator = v.object({
  hypothesis: v.string(),
  test: v.string(),
  successMetric: v.string(),
});

export const researchCohortReportValidator = v.object({
  answerToQuestion: v.string(),
  executiveSummary: v.string(),
  avatars: v.array(researchAvatarValidator),
  primaryAvatar: v.string(),
  secondaryAvatars: v.array(v.string()),
  crossCohortPatterns: v.array(v.string()),
  unknowns: v.array(v.string()),
  followUpExperiments: v.array(researchExperimentValidator),
  privacyNote: v.string(),
  coverage: v.object({
    usersRequested: v.number(),
    usersAnalyzed: v.number(),
    chatsReviewed: v.number(),
    messagesReviewed: v.number(),
  }),
});

export const researchRunStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);
