import { z } from "zod";

export const findingEvidenceStatusSchema = z.enum([
  "source_review_only",
  "runtime_reproduced",
  "inconclusive",
]);
export type FindingEvidenceStatus = z.infer<typeof findingEvidenceStatusSchema>;
export const FINDING_EVIDENCE_LABELS: Record<FindingEvidenceStatus, string> = {
  source_review_only: "Source review only",
  runtime_reproduced: "Runtime reproduced",
  inconclusive: "Inconclusive",
};

export function findingEvidenceLabel(status?: FindingEvidenceStatus): string {
  return status ? FINDING_EVIDENCE_LABELS[status] : "Not recorded";
}

// These fields change the basis of the claim. An earlier reproduction must not
// silently attest to a different target, PoC, capture, or analysis after correction.
export const EVIDENCE_BASIS_FIELDS = [
  "title",
  "description",
  "impact",
  "assumptions",
  "counterevidence",
  "target",
  "endpoint",
  "method",
  "technical_analysis",
  "poc_description",
  "poc_script_code",
  "evidence",
  "evidence_refs",
  "code_locations",
] as const;
