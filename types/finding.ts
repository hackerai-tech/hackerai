import type { Cvss31Breakdown, FindingSeverity } from "@/lib/findings/cvss31";
import type { FindingCodeLocation } from "@/lib/findings/validation";
import type { FindingCategory } from "@/lib/findings/category";
import type {
  FindingClosureReason,
  FindingStatus,
} from "@/lib/findings/lifecycle";

export type {
  Cvss31Breakdown,
  FindingCategory,
  FindingClosureReason,
  FindingSeverity,
  FindingStatus,
  FindingCodeLocation,
};

export interface FindingSummary {
  finding_id: string;
  title: string;
  target: string;
  endpoint?: string;
  severity: FindingSeverity;
  cvss_score: number;
  category: FindingCategory;
  status: FindingStatus;
  chat_id: string;
  chat_title: string;
  created_at: number;
  project_id?: string;
  evidence_status?: import("@/lib/findings/evidence-status").FindingEvidenceStatus;
}

export interface FindingDetailRecord extends FindingSummary {
  description: string;
  impact: string;
  technical_analysis: string;
  poc_description: string;
  poc_script_code: string;
  remediation_steps: string;
  evidence: string;
  evidence_refs?: string[];
  evidence_verification?: import("@/lib/ai/subagents/contracts").EvidenceVerification;
  assumptions: string;
  evidence_status_reason?: string;
  confidence?: "low" | "medium" | "high";
  confidence_rationale?: string;
  correction_history?: Array<{
    updated_at: number;
    message_id: string;
    reason: string;
    changed_fields: string[];
    previous_severity: string;
    severity: string;
    previous_cvss_score: number;
    cvss_score: number;
    previous_confidence?: string;
    confidence?: string;
  }>;
  correction_count?: number;
  usefulness_feedback?: {
    answer: "useful" | "needs_correction" | "not_checked";
    report_updated_at: number;
    submitted_at: number;
  };
  counterevidence?: string;
  severity_change_conditions?: string;
  fix_effort: "trivial" | "low" | "medium" | "high";
  cvss_breakdown: Cvss31Breakdown;
  cvss_vector: string;
  method?: string;
  cve?: string;
  cwe?: string;
  code_locations?: FindingCodeLocation[];
  message_id: string;
  closure_reason?: FindingClosureReason;
  closure_context?: string;
  closed_at?: number;
  updated_at: number;
}

export type FindingRetestRunView = {
  run_id: string;
  request_id: string;
  status: "running" | "finished";
  recipe_version: number;
  recipe: import("@/lib/findings/http-retest").HttpRetestRecipe;
  started_at: number;
  finished_at?: number;
  outcome?: import("@/lib/findings/http-retest").HttpRetestOutcome;
  reason?: import("@/lib/findings/http-retest").HttpRetestReason;
  steps?: import("@/lib/findings/http-retest").HttpRetestStep[];
  environment?: { kind: "cloud" | "local" | "desktop"; name?: string };
  evidence_sha256?: string;
};

export type FindingRetestRecipeView = {
  version: number;
  recipe: import("@/lib/findings/http-retest").HttpRetestRecipe;
  source: "user" | "agent";
  created_at: number;
};

/** Response of GET /api/finding-retests. */
export type FindingRetestState =
  | { enabled: false }
  | {
      enabled: true;
      finding: { finding_id: string; chat_title: string; target: string };
      environment: { kind: "cloud" | "local"; revision: string };
      recipe: FindingRetestRecipeView | null;
      runs: FindingRetestRunView[];
      server_time: number;
    };

export interface FindingSourceChat {
  chat_id: string;
  chat_title: string;
}
