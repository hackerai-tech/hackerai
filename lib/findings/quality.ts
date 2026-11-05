import type { RefinementCtx } from "zod";

/** Required for new submissions and corrected reports; legacy records remain readable. */
export function validateFindingAssessment(
  input: {
    confidence?: string | null;
    confidence_rationale?: string | null;
    counterevidence?: string | null;
    severity_change_conditions?: string | null;
  },
  ctx: RefinementCtx,
) {
  if (
    input.confidence &&
    input.confidence !== "high" &&
    !input.confidence_rationale?.trim()
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["confidence_rationale"],
      message: "Explain the proof gap when confidence is low or medium.",
    });
  }
}
