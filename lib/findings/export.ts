import type { FindingDetailRecord } from "@/types/finding";
import { findingEvidenceLabel } from "./evidence-status";
import { renderFindingMarkdown } from "./markdown";
import { getSourceMessageHref } from "./source-message";

export const FINDING_EXPORT_FORMATS = [
  "markdown",
  "pdf",
  "html",
  "json",
  "sarif",
] as const;
export type FindingExportFormat = (typeof FINDING_EXPORT_FORMATS)[number];
export const MAX_EXPORTED_FINDINGS = 50;
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export interface FindingsReport {
  schema_version: 1;
  title: string;
  generated_at: string;
  coverage: "selected-saved-findings";
  limitations: string;
  findings: Array<FindingDetailRecord & { source_url: string }>;
}

export function createFindingsReport(
  findings: FindingDetailRecord[],
  baseUrl = "https://hackerai.co",
  now = new Date(),
): FindingsReport {
  if (!findings.length || findings.length > MAX_EXPORTED_FINDINGS)
    throw new Error("Select between 1 and 50 findings");
  if (new Set(findings.map((f) => f.finding_id)).size !== findings.length)
    throw new Error("Duplicate selection");
  const origin = new URL(baseUrl).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error("Invalid source origin");
  const report: FindingsReport = {
    schema_version: 1,
    title:
      findings.length === 1 ? findings[0].title : "Security findings report",
    generated_at: now.toISOString(),
    coverage: "selected-saved-findings",
    limitations:
      "This report contains only the selected saved findings, not complete assessment coverage. Evidence basis is Agent-reported, not independent verification. Missing evidence status is not inferred. Saved-file checks establish availability, not vulnerability validity. Each finding retains its own assessment time and limitations.",
    findings: findings.map((f) => ({
      ...f,
      source_url: new URL(getSourceMessageHref(f.chat_id, f.message_id), origin)
        .href,
    })),
  };
  if (
    new TextEncoder().encode(JSON.stringify(report)).length > MAX_REPORT_BYTES
  )
    throw new Error("Report too large; select fewer findings");
  return report;
}

export function renderFindingsMarkdown(report: FindingsReport): string {
  return (
    [
      "# Security findings report",
      "",
      `Generated: ${report.generated_at}`,
      `Selected findings: ${report.findings.length}`,
      "",
      report.limitations,
      ...report.findings.map(
        (f) =>
          `\n---\n\nSource: ${f.source_url}\n\n${renderFindingMarkdown(f)}`,
      ),
    ].join("\n") + "\n"
  );
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

// Render only headings and code fences. All report text is escaped; raw HTML,
// images, markdown links and scripts never become active offline content.
export function renderFindingsHtml(report: FindingsReport): string {
  let fenced = false;
  let fenceSize = 0;
  const body = renderFindingsMarkdown(report)
    .split("\n")
    .map((line) => {
      const fence = line.match(/^(`{3,})\s*$/);
      if (fence && (!fenced || fence[1].length >= fenceSize)) {
        fenced = !fenced;
        fenceSize = fenced ? fence[1].length : 0;
        return fenced ? "<pre><code>" : "</code></pre>";
      }
      if (fenced) return escapeHtml(line) + "\n";
      const heading = line.match(/^(#{1,3}) (.*)$/);
      if (heading)
        return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
      if (line === "---") return "<hr>";
      return `<div class="line">${escapeHtml(line) || "&nbsp;"}</div>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title><style>body{font:15px/1.65 system-ui,sans-serif;color:#17202a;background:#fff;max-width:960px;margin:40px auto;padding:0 24px}h1{font-size:28px;line-height:1.25}h2{font-size:20px;margin-top:32px}h3{font-size:17px}.line{white-space:pre-wrap;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;border:1px solid #d9dfe7;border-radius:8px;padding:16px;font-size:12px}hr{border:0;border-top:1px solid #d9dfe7;margin:36px 0}@media print{body{margin:0}h1,h2,h3{break-after:avoid}pre{break-inside:auto}}</style></head><body>${body}${fenced ? "</code></pre>" : ""}</body></html>`;
}

export function renderFindingsSarif(report: FindingsReport) {
  const rules = new Map<
    string,
    { id: string; name: string; shortDescription: { text: string } }
  >();
  for (const f of report.findings) {
    const id = f.cwe ?? `hackerai/${f.category}`;
    if (!rules.has(id))
      rules.set(id, {
        id,
        name: id,
        shortDescription: { text: f.cwe ?? f.category },
      });
  }
  const ruleList = [...rules.values()];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "HackerAI",
            informationUri: "https://hackerai.co",
            rules: ruleList,
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.cwe ?? `hackerai/${f.category}`,
          ruleIndex: ruleList.findIndex(
            (r) => r.id === (f.cwe ?? `hackerai/${f.category}`),
          ),
          level:
            f.severity === "critical" || f.severity === "high"
              ? "error"
              : f.severity === "medium" || f.severity === "low"
                ? "warning"
                : "note",
          message: {
            text: `${f.title}\n\n${f.description}`,
            markdown: renderFindingMarkdown(f),
          },
          partialFingerprints: { "hackeraiFindingId/v1": f.finding_id },
          locations: f.code_locations?.map((location) => ({
            physicalLocation: {
              artifactLocation: {
                uri: location.file.split("/").map(encodeURIComponent).join("/"),
                uriBaseId: "%SRCROOT%",
              },
              region: {
                startLine: location.start_line,
                endLine: location.end_line,
                ...(location.snippet
                  ? { snippet: { text: location.snippet } }
                  : {}),
              },
            },
          })),
          properties: {
            finding_id: f.finding_id,
            target: f.target,
            severity: f.severity,
            cvss_score: f.cvss_score,
            cvss_vector: f.cvss_vector,
            status: f.status,
            evidence_basis: findingEvidenceLabel(f.evidence_status),
            confidence: f.confidence ?? "not_recorded",
            source_url: f.source_url,
            // Retain the complete selected record: SARIF has no standard fields for
            // proof, assessment limits, captures or closure rationale.
            report: f,
          },
        })),
        properties: {
          generated_at: report.generated_at,
          coverage: report.coverage,
          limitations: report.limitations,
        },
      },
    ],
  };
}

export async function exportFindingsReport(
  report: FindingsReport,
  format: FindingExportFormat,
  fontBytes?: ArrayBuffer,
) {
  const stem =
    report.findings.length === 1
      ? `finding-${report.findings[0].finding_id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      : `findings-${report.generated_at.slice(0, 10)}`;
  if (format === "pdf") {
    if (!fontBytes) throw new Error("PDF font is unavailable");
    const { renderFindingsPdf } = await import("./pdf");
    return {
      filename: `${stem}.pdf`,
      content: await renderFindingsPdf(report, fontBytes),
      mimeType: "application/pdf",
    };
  }
  if (format === "html")
    return {
      filename: `${stem}.html`,
      content: renderFindingsHtml(report),
      mimeType: "text/html;charset=utf-8",
    };
  if (format === "json" || format === "sarif")
    return {
      filename: `${stem}.${format === "sarif" ? "sarif" : "json"}`,
      content: JSON.stringify(
        format === "json" ? report : renderFindingsSarif(report),
        null,
        2,
      ),
      mimeType:
        format === "json" ? "application/json" : "application/sarif+json",
    };
  return {
    filename: `${stem}.md`,
    content: renderFindingsMarkdown(report),
    mimeType: "text/markdown;charset=utf-8",
  };
}
