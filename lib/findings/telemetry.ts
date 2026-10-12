/** Deliberately content-free: never pass reports, errors, paths or search text here. */
export type FindingOperation =
  | "create"
  | "list"
  | "get"
  | "update"
  | "load"
  | "close"
  | "export"
  | "feedback"
  | "search"
  | "source";
export type FindingOutcome =
  "success" | "rejected" | "failed" | "canceled" | "uncertain" | "initiated";
export interface FindingEvent {
  operation: FindingOperation;
  outcome: FindingOutcome;
  reason?:
    | "provenance"
    | "validation"
    | "evidence"
    | "conflict"
    | "duplicate"
    | "not_found"
    | "chat_not_found"
    | "general"
    | "unsupported_native";
  finding_id?: string;
  report_updated_at?: number;
  duration_ms?: number;
  evidence_warning?: boolean;
  surface?: "computer_sidebar" | "findings_page" | "detail";
  format?: "markdown" | "csv";
  answer?: "useful" | "needs_correction" | "not_checked";
  closure_reason?: "already_fixed" | "wont_fix" | "false_positive";
  result_count?: number;
  has_search?: boolean;
}
export function findingEventProperties(event: FindingEvent) {
  // Explicit projection prevents accidental extra properties from crossing this boundary.
  return {
    finding_event_version: 1,
    operation: event.operation,
    outcome: event.outcome,
    ...(event.reason && { reason: event.reason }),
    ...(event.finding_id && { finding_id: event.finding_id }),
    ...(event.report_updated_at !== undefined && {
      report_updated_at: event.report_updated_at,
    }),
    ...(event.duration_ms !== undefined && {
      duration_ms: Math.max(0, Math.round(event.duration_ms)),
    }),
    ...(event.evidence_warning !== undefined && {
      evidence_warning: event.evidence_warning,
    }),
    ...(event.surface && { surface: event.surface }),
    ...(event.format && { format: event.format }),
    ...(event.answer && { answer: event.answer }),
    ...(event.closure_reason && { closure_reason: event.closure_reason }),
    ...(event.result_count !== undefined && {
      result_count: event.result_count,
    }),
    ...(event.has_search !== undefined && { has_search: event.has_search }),
  };
}
