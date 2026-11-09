/** @jest-environment node */
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  createFindingsReport,
  exportFindingsReport,
  renderFindingsHtml,
  renderFindingsSarif,
  MAX_EXPORTED_FINDINGS,
} from "../export";
import type { FindingDetailRecord } from "@/types/finding";

const finding: FindingDetailRecord = {
  finding_id: "f-1",
  title: 'Invoice access <script>alert("x")</script> – résumé',
  target: "https://example.test",
  severity: "high",
  cvss_score: 6.5,
  category: "access_control",
  status: "active",
  chat_id: "c-1",
  chat_title: "Assessment",
  message_id: "m-1",
  created_at: 1,
  updated_at: 2,
  description: "Another account's invoice can be read.",
  impact: "Billing data disclosure.",
  technical_analysis: "Missing owner check.",
  poc_description: "1. Authenticate as A.\n2. Request B's invoice.",
  poc_script_code: "curl /invoice/b\n```\n<script>unsafe()</script>",
  remediation_steps: "Require matching ownership.",
  evidence: "HTTP 200\nB's invoice 中文",
  evidence_refs: ["/workspace/response.txt"],
  evidence_verification: {
    checked_refs: [],
    unavailable_refs: ["/workspace/response.txt"],
    warning: "Capture unavailable; proof incomplete.",
  },
  assumptions: "Two ordinary accounts.",
  confidence: "medium",
  confidence_rationale: "Capture needs independent inspection.",
  counterevidence: "Other endpoints enforce ownership.",
  severity_change_conditions: "An owner check would reject the request.",
  evidence_status: "inconclusive",
  evidence_status_reason: "The current capture is unavailable.",
  fix_effort: "low",
  cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
  cvss_breakdown: {
    attack_vector: "N",
    attack_complexity: "L",
    privileges_required: "L",
    user_interaction: "N",
    scope: "U",
    confidentiality: "H",
    integrity: "N",
    availability: "N",
  },
  code_locations: [
    {
      file: "src/invoices.ts",
      start_line: 4,
      end_line: 7,
      snippet: "getInvoice(id)",
    },
  ],
};
const report = () =>
  createFindingsReport(
    [finding],
    "https://preview.example.test",
    new Date("2026-11-09T12:00:00Z"),
  );

describe("selected finding reports", () => {
  it("preserves complete saved evidence, limitations and source provenance in JSON", async () => {
    const file = await exportFindingsReport(report(), "json");
    const parsed = JSON.parse(file.content as string);
    expect(parsed.findings[0]).toMatchObject(finding);
    expect(parsed.findings[0].source_url).toBe(
      "https://preview.example.test/c/c-1#message=m-1",
    );
    expect(parsed.coverage).toBe("selected-saved-findings");
    expect(parsed.limitations).toContain("not complete assessment coverage");
  });
  it("rejects empty, duplicate and oversized selections instead of truncating them", () => {
    expect(() => createFindingsReport([])).toThrow();
    expect(() => createFindingsReport([finding, finding])).toThrow("Duplicate");
    expect(() =>
      createFindingsReport(
        Array.from({ length: MAX_EXPORTED_FINDINGS + 1 }, (_, i) => ({
          ...finding,
          finding_id: String(i),
        })),
      ),
    ).toThrow();
  });
  it("includes proof warnings and explicit unknown status in Markdown for legacy records", async () => {
    const r = createFindingsReport([
      {
        ...finding,
        evidence_status: undefined,
        evidence_status_reason: undefined,
      },
    ]);
    const file = await exportFindingsReport(r, "markdown");
    expect(file.content).toContain("Not recorded");
    expect(file.content).toContain("no runtime reproduction is inferred");
    expect(file.content).toContain(finding.poc_script_code);
    expect(file.content).toContain(finding.evidence_verification!.warning);
    expect(file.content).toContain(finding.assumptions);
  });
  it("exports inert self-contained HTML even for attacker-controlled titles and captures", () => {
    const html = renderFindingsHtml(report());
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("中文");
    expect(html).toContain("Capture unavailable; proof incomplete.");
  });
  it("maps SARIF diagnostics without treating evidence basis or closure as verification", () => {
    const sarif = renderFindingsSarif(report());
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "hackerai/access_control",
      level: "error",
      properties: { evidence_basis: "Inconclusive", report: finding },
    });
    expect(sarif.runs[0].results[0]).not.toHaveProperty("kind", "pass");
    expect(
      sarif.runs[0].results[0].locations?.[0].physicalLocation.region,
    ).toMatchObject({ startLine: 4, endLine: 7 });
  });
  it("generates a real multi-page PDF with embedded font and exact original JSON attachment", async () => {
    const font = readFileSync("public/fonts/report/NotoSans-Regular.ttf");
    const r = createFindingsReport([
      {
        ...finding,
        technical_analysis:
          "Long assessment line that must wrap instead of clipping. ".repeat(
            1500,
          ),
      },
    ]);
    const file = await exportFindingsReport(
      r,
      "pdf",
      font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength),
    );
    expect(file.content).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(file.content).subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(file.content);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.catalog.has((await import("pdf-lib")).PDFName.of("Names"))).toBe(
      true,
    );
    expect(pdf.getTitle()).toBe(finding.title);
  });
});
