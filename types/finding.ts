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
  /** Schedule whose task saved this finding. The name is the saved snapshot. */
  schedule?: { id: string; name: string };
}

/** One run of the schedule that reported this finding, newest first. */
export type FindingScheduledObservation = {
  observedAt: number;
  /** False once that run's task is deleted. */
  taskAvailable: boolean;
  /** Present only while the task is available. */
  chatId?: string;
  messageId?: string;
};

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
  /** False once the schedule is deleted; its name remains, without a link. */
  scheduleAvailable?: boolean;
  /** Latest runs that reported this finding; `observationCount` covers all of them. */
  scheduledObservations?: FindingScheduledObservation[];
  observationCount?: number;
  correction_history?: Array<{
    updated_at: number;
    message_id: string;
    /**
     * Task of the later schedule run that made this correction. Absent for a
     * correction from the finding's own source task.
     */
    chat_id?: string;
    /** False when that later run's task was deleted; its message cannot be linked. */
    task_available?: false;
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

/** One Agent retest assessment. `interrupted` runs ended without a result. */
export type FindingAgentRetestView = {
  retest_id: string;
  chat_id: string;
  assistant_message_id: string;
  status: "running" | "finished";
  started_at: number;
  finished_at?: number;
  outcome?: import("@/lib/findings/agent-retest").AgentRetestOutcome;
  interrupted?: boolean;
  summary?: string;
  reproduction_steps?: string[];
  expected_result?: string;
  observed_result?: string;
  evidence_refs?: string[];
  evidence_verification?: import("@/lib/ai/subagents/contracts").EvidenceVerification;
  limitations?: string[];
  environment?: { kind: "cloud" | "local" | "desktop"; name?: string };
};

/** Response of GET /api/finding-retests. */
export type FindingRetestState =
  | { enabled: false }
  | {
      enabled: true;
      chat_title: string;
      retests: FindingAgentRetestView[];
    };

/** One individually saved hunt candidate. Agent judgment, never a finding. */
export type FindingHuntCandidateView = {
  candidate_key: string;
  surface: string;
  rationale: string;
  outcome: import("@/lib/findings/variant-hunt").HuntCandidateOutcome;
  evidence_basis?: import("@/lib/findings/variant-hunt").HuntEvidenceBasis;
  /** Agent's claim of a successful same-surface authorized control. Older rows omit it. */
  authorized_control_succeeded?: boolean;
  reproduction_steps: string[];
  expected_result?: string;
  observed_result?: string;
  evidence_refs: string[];
  evidence_verification?: import("@/lib/ai/subagents/contracts").EvidenceVerification;
  limitations: string[];
  recorded_at: number;
};

/** One hunt. `interrupted` hunts ended early; saved candidates are kept. */
export type FindingHuntView = {
  hunt_id: string;
  chat_id: string;
  assistant_message_id: string;
  status: "running" | "finished";
  started_at: number;
  finished_at?: number;
  interrupted?: boolean;
  summary?: string;
  limitations?: string[];
  environment?: { kind: "cloud" | "local" | "desktop"; name?: string };
  candidates: FindingHuntCandidateView[];
};

/** Response of GET /api/finding-hunts. */
export type FindingHuntState =
  | { enabled: false }
  | {
      enabled: true;
      chat_title: string;
      hunts: FindingHuntView[];
    };

export interface FindingSourceChat {
  chat_id: string;
  chat_title: string;
}
