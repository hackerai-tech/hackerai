import type { Cvss31Breakdown, FindingSeverity } from "@/lib/findings/cvss31";
import type { FindingCodeLocation } from "@/lib/findings/validation";

export type { Cvss31Breakdown, FindingSeverity, FindingCodeLocation };

export interface FindingSummary {
  finding_id: string;
  title: string;
  target: string;
  endpoint?: string;
  severity: FindingSeverity;
  cvss_score: number;
  chat_id: string;
  chat_title: string;
  created_at: number;
}

export interface FindingDetailRecord extends FindingSummary {
  description: string;
  impact: string;
  technical_analysis: string;
  poc_description: string;
  poc_script_code: string;
  remediation_steps: string;
  evidence: string;
  assumptions: string;
  fix_effort: "trivial" | "low" | "medium" | "high";
  cvss_breakdown: Cvss31Breakdown;
  cvss_vector: string;
  method?: string;
  cve?: string;
  cwe?: string;
  code_locations?: FindingCodeLocation[];
  message_id: string;
  updated_at: number;
}

export interface FindingSourceChat {
  chat_id: string;
  chat_title: string;
}
