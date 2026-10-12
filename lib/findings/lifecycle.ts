import { z } from "zod";

export const FINDING_STATUSES = ["active", "closed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_CLOSURE_REASONS = [
  "already_fixed",
  "wont_fix",
  "false_positive",
] as const;
export type FindingClosureReason = (typeof FINDING_CLOSURE_REASONS)[number];

export const FINDING_CLOSURE_REASON_LABELS: Record<
  FindingClosureReason,
  string
> = {
  already_fixed: "Already fixed",
  wont_fix: "Won't fix",
  false_positive: "False positive",
};

export const FINDING_CLOSURE_CONTEXT_MAX = 4_000;

export const closeFindingInputSchema = z
  .object({
    reason: z.enum(FINDING_CLOSURE_REASONS),
    context: z
      .string()
      .trim()
      .min(1, "Context is required")
      .max(
        FINDING_CLOSURE_CONTEXT_MAX,
        `Context must be ${FINDING_CLOSURE_CONTEXT_MAX.toLocaleString()} characters or fewer`,
      ),
  })
  .strict();
