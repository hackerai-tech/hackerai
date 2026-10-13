import type { CreateVulnerabilityReportInput } from "./validation";

// Bound both the database read and model input. Exact matching still searches
// the entire chat; semantic comparison covers the most recent findings.
export const FINDING_DEDUPE_LIMIT = 25;
export type FindingDedupeVersion = { finding_id: string; updated_at: number };
export type FindingDedupeCandidate = FindingDedupeVersion & { summary: string };
export type FindingDedupeContext = {
  exact_duplicate_id: string | null;
  candidates: FindingDedupeCandidate[];
};

export function findingComparisonSummary(
  report: Pick<
    CreateVulnerabilityReportInput,
    "title" | "target" | "description" | "technical_analysis"
  > &
    Partial<
      Pick<CreateVulnerabilityReportInput, "endpoint" | "method" | "cwe">
    > & {
      code_locations?: Array<{
        file: string;
        start_line: number;
        end_line: number;
      }>;
    },
): string {
  // Raw captures, PoCs and attachments are not needed for this comparison.
  return JSON.stringify({
    truncated:
      report.title.length > 200 ||
      report.target.length > 1_000 ||
      (report.endpoint?.length ?? 0) > 500 ||
      report.description.length > 600 ||
      report.technical_analysis.length > 1_000 ||
      (report.code_locations?.length ?? 0) > 4 ||
      (report.code_locations?.some((location) => location.file.length > 200) ??
        false),
    title: report.title.slice(0, 200),
    target: report.target.slice(0, 1_000),
    endpoint: report.endpoint?.slice(0, 500),
    method: report.method,
    cwe: report.cwe,
    description: report.description.slice(0, 600),
    technical_analysis: report.technical_analysis.slice(0, 1_000),
    code_locations: report.code_locations?.slice(0, 4).map((location) => ({
      file: location.file.slice(0, 200),
      start_line: location.start_line,
      end_line: location.end_line,
    })),
  });
}

export function findingDedupeVersions(candidates: FindingDedupeVersion[]) {
  return candidates.map(({ finding_id, updated_at }) => ({
    finding_id,
    updated_at,
  }));
}

export function sameFindingDedupeVersions(
  a: FindingDedupeVersion[],
  b: FindingDedupeVersion[],
) {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.finding_id === b[index].finding_id &&
        entry.updated_at === b[index].updated_at,
    )
  );
}
