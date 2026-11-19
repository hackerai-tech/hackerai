import {
  createFindingDedupeKey,
  type CreateVulnerabilityReportInput,
} from "./validation";

// Bound both the database read and model input. Semantic comparison covers the
// most recent findings plus a bounded group sharing the stored coarse key.
export const FINDING_DEDUPE_LIMIT = 25;
export const FINDING_DEDUPE_RECENT_MAX_BYTES = 2_000_000;
export const FINDING_DEDUPE_GROUP_LIMIT = 10;
// Soft cap: the group read stops once this is reached, so the last loaded
// document may cross it.
export const FINDING_DEDUPE_GROUP_MAX_BYTES = 1_000_000;
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

/** Saved rows and parsed reports both carry these fields; legacy rows may omit optional ones. */
export type FindingIdentitySource = Pick<
  CreateVulnerabilityReportInput,
  | "title"
  | "description"
  | "impact"
  | "target"
  | "technical_analysis"
  | "poc_description"
  | "poc_script_code"
  | "remediation_steps"
  | "evidence"
  | "assumptions"
  | "fix_effort"
  | "cvss_breakdown"
> &
  Partial<
    Pick<
      CreateVulnerabilityReportInput,
      | "evidence_refs"
      | "evidence_status"
      | "evidence_status_reason"
      | "confidence"
      | "confidence_rationale"
      | "counterevidence"
      | "severity_change_conditions"
      | "endpoint"
      | "method"
      | "cve"
      | "cwe"
    >
  > & {
    code_locations?: Array<{
      file: string;
      start_line: number;
      end_line: number;
      snippet?: string;
      label?: string;
      fix_before?: string;
      fix_after?: string;
    }>;
  };

const text = (value: string | null | undefined) => {
  const normalized = (value ?? "").replace(/\r\n?/g, "\n").trim();
  return normalized || null;
};

// RFC 3986 treats only the scheme and host as case-insensitive. Paths, queries,
// user information and anything that is not an absolute URL keep their case.
const locator = (value: string | null | undefined) => {
  const trimmed = text(value);
  const url = trimmed?.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i);
  if (!url) return trimmed;
  const [, scheme, authority, rest] = url;
  const at = authority.lastIndexOf("@");
  return `${scheme.toLowerCase()}${authority.slice(0, at + 1)}${authority
    .slice(at + 1)
    .toLowerCase()}${rest}`;
};

/**
 * A conservative identity for skipping model comparison. Only title, CWE, method
 * and URL scheme/host receive cosmetic normalization; every other report field
 * must match apart from line endings and outer whitespace. Anything else is left
 * to semantic comparison, which preserves the report when uncertain.
 */
export function findingIdentity(report: FindingIdentitySource): string {
  const breakdown = report.cvss_breakdown as Record<string, string>;
  return JSON.stringify([
    createFindingDedupeKey({
      title: report.title,
      target: report.target,
      endpoint: report.endpoint,
      method: report.method,
      cwe: report.cwe,
    }),
    locator(report.target),
    locator(report.endpoint),
    text(report.cve),
    text(report.description),
    text(report.impact),
    text(report.technical_analysis),
    text(report.poc_description),
    text(report.poc_script_code),
    text(report.remediation_steps),
    text(report.evidence),
    report.evidence_refs ?? null,
    text(report.assumptions),
    report.evidence_status ?? null,
    text(report.evidence_status_reason),
    report.confidence ?? null,
    text(report.confidence_rationale),
    text(report.counterevidence),
    text(report.severity_change_conditions),
    report.fix_effort,
    Object.keys(breakdown)
      .sort()
      .map((key) => [key, breakdown[key]]),
    report.code_locations?.length
      ? report.code_locations.map((location) => [
          location.file,
          location.start_line,
          location.end_line,
          text(location.snippet),
          text(location.label),
          text(location.fix_before),
          text(location.fix_after),
        ])
      : null,
  ]);
}

export function sameFindingIdentity(
  a: FindingIdentitySource,
  b: FindingIdentitySource,
) {
  return findingIdentity(a) === findingIdentity(b);
}

/**
 * Recent findings first (newest first), then older rows from the coarse-key
 * group in index order. Context and create must both use this ordering so the
 * comparison snapshot fences every row the model saw.
 */
export function mergeFindingDedupeCandidates<T extends { finding_id: string }>(
  recent: T[],
  group: T[],
): T[] {
  const seen = new Set(recent.map((finding) => finding.finding_id));
  return [
    ...recent,
    ...group.filter((finding) => {
      if (seen.has(finding.finding_id)) return false;
      seen.add(finding.finding_id);
      return true;
    }),
  ];
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
