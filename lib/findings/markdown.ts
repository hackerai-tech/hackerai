import type { FindingDetailRecord } from "@/types/finding";

// Keep embedded fences in PoCs and patches from closing the report's code block.
const codeBlock = (code: string) => {
  const longest = Math.max(
    2,
    ...(code.match(/`+/g) ?? []).map((s) => s.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${code}\n${fence}`;
};

/** Export the saved finding without another model call or sandbox execution. */
export function renderFindingMarkdown(finding: FindingDetailRecord): string {
  const sections: Array<[string, string | undefined]> = [
    ["Description", finding.description],
    ["Impact", finding.impact],
    ["Evidence", finding.evidence],
    ["Technical analysis", finding.technical_analysis],
    ["Reproduction steps", finding.poc_description],
    ["Proof of concept", codeBlock(finding.poc_script_code)],
    ["Assumptions and prerequisites", finding.assumptions],
    ["Remediation", finding.remediation_steps],
  ];
  const lines = [
    `# ${finding.title.replace(/[\r\n]+/g, " ")}`,
    "",
    `Severity: ${finding.severity} (${finding.cvss_score})`,
    `CVSS: ${finding.cvss_vector}`,
    `Status: ${finding.status}`,
    `Target: ${finding.target}`,
    ...(finding.endpoint ? [`Endpoint: ${finding.endpoint}`] : []),
    ...(finding.method ? [`Method: ${finding.method}`] : []),
    ...(finding.cve ? [`CVE: ${finding.cve}`] : []),
    ...(finding.cwe ? [`CWE: ${finding.cwe}`] : []),
    `Fix effort: ${finding.fix_effort}`,
    `Created: ${new Date(finding.created_at).toISOString()}`,
    `Updated: ${new Date(finding.updated_at).toISOString()}`,
  ];
  for (const [title, value] of sections) {
    if (value) lines.push("", `## ${title}`, "", value);
  }
  if (finding.evidence_refs?.length) {
    lines.push(
      "",
      "## Evidence references",
      "",
      codeBlock(finding.evidence_refs.join("\n")),
    );
  }
  if (finding.evidence_verification?.warning) {
    lines.push(
      "",
      "## Evidence verification incomplete",
      "",
      finding.evidence_verification.warning,
      "",
      codeBlock(finding.evidence_verification.unavailable_refs.join("\n")),
    );
  }
  for (const location of finding.code_locations ?? []) {
    lines.push(
      "",
      "## Code location",
      "",
      `${location.file}:${location.start_line}-${location.end_line}`,
    );
    if (location.label) lines.push("", location.label);
    if (location.snippet) lines.push("", codeBlock(location.snippet));
    if (location.fix_before && location.fix_after) {
      lines.push(
        "",
        "### Before",
        "",
        codeBlock(location.fix_before),
        "",
        "### After",
        "",
        codeBlock(location.fix_after),
      );
    }
  }
  if (finding.status === "closed") {
    lines.push(
      "",
      "## Closure",
      "",
      `Reason: ${finding.closure_reason ?? "unspecified"}`,
    );
    if (finding.closure_context) lines.push("", finding.closure_context);
    if (finding.closed_at)
      lines.push("", `Closed: ${new Date(finding.closed_at).toISOString()}`);
  }
  return `${lines.join("\n")}\n`;
}
