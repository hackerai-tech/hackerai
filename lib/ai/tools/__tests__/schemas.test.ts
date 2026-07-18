import {
  createAgentToolSchemaSet,
  createFileToolSchema,
  createRunTerminalCmdToolSchema,
  createVulnerabilityReportTool,
  createVulnerabilityReportToolInputSchema,
  runTerminalCmdTool,
} from "../schemas";
import { createVulnerabilityReportInputSchema } from "@/lib/findings/validation";

const getDescription = (value: unknown): string =>
  (value as { description: string }).description;

const getInputShape = (value: unknown): Record<string, unknown> =>
  (value as { inputSchema: { shape: Record<string, unknown> } }).inputSchema
    .shape;

const validFindingReport = () => ({
  title: "Cross-tenant invoice access",
  description: "An authenticated user can read another user's invoice.",
  impact: "A user can disclose another customer's billing address.",
  target: "https://app.example.test",
  endpoint: "/api/invoices/:id",
  method: "GET",
  cve: "CVE-2026-12345",
  cwe: "CWE-639",
  technical_analysis: "The handler loads by invoice id without an owner check.",
  poc_description: "Sign in as user A and request user B's invoice id.",
  poc_script_code: "\n  curl /api/invoices/user-b\n",
  remediation_steps: "Scope the query to the authenticated account.",
  evidence: "The response returned HTTP 200 and user B's billing address.",
  assumptions: "Both accounts are ordinary customer accounts.",
  fix_effort: "low",
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
      file: "app/api/invoices/[id]/route.ts",
      start_line: 20,
      end_line: 21,
      fix_before: "\n  where: { id },\n  include: { items: true },\n",
      fix_after: "\n  where: { id, userId },\n  include: { items: true },\n",
    },
  ],
});

const findingValidationResult = (result: {
  success: boolean;
  data?: unknown;
  error?: {
    issues: Array<{ code: string; message: string; path: PropertyKey[] }>;
  };
}) =>
  result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        issues: result.error?.issues.map(({ code, message, path }) => ({
          code,
          message,
          path,
        })),
      };

describe("agent tool schema descriptions", () => {
  test("exposes structured findings only in persistent Agent modes", () => {
    expect(createAgentToolSchemaSet({ mode: "agent" })).toHaveProperty(
      "create_vulnerability_report",
    );
    expect(createAgentToolSchemaSet({ mode: "ask" })).not.toHaveProperty(
      "create_vulnerability_report",
    );
    expect(
      createAgentToolSchemaSet({ mode: "agent", isTemporary: true }),
    ).not.toHaveProperty("create_vulnerability_report");
  });

  test("keeps the standalone model schema in parity with server validation", () => {
    const parsed = createVulnerabilityReportToolInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining([
          "title",
          "description",
          "impact",
          "target",
          "technical_analysis",
          "poc_description",
          "poc_script_code",
          "remediation_steps",
          "evidence",
          "assumptions",
          "fix_effort",
          "cvss_breakdown",
        ]),
      );
    }

    const validReport = validFindingReport();
    const parityCases = [
      validReport,
      {},
      { ...validReport, cve: "CVE-26-1234" },
      {
        ...validReport,
        code_locations: [{ file: "../secret.ts", start_line: 1, end_line: 1 }],
      },
      {
        ...validReport,
        code_locations: [
          {
            file: "src/a.ts",
            start_line: 4,
            end_line: 5,
            fix_before: "unsafe()",
            fix_after: "safe()",
          },
        ],
      },
      { ...validReport, evidence: "x".repeat(132_000) },
    ];

    for (const input of parityCases) {
      expect(
        findingValidationResult(
          createVulnerabilityReportToolInputSchema.safeParse(input),
        ),
      ).toEqual(
        findingValidationResult(
          createVulnerabilityReportInputSchema.safeParse(input),
        ),
      );
    }
  });

  test("allows one bounded retry only for an explicitly retryable save failure", () => {
    const description = getDescription(createVulnerabilityReportTool);

    expect(description).toContain(
      "Persist at most one successful report for each distinct confirmed root cause",
    );
    expect(description).toContain(
      "explicitly returns retryable: true, retry the same report once",
    );
    expect(description).toContain("Never retry a duplicate response");
    expect(description).toContain(
      "fix_before must be a verbatim copy of exactly that range",
    );
    expect(description).toContain(
      "Split non-contiguous changes into separate labeled code locations",
    );
  });

  test("terminal command approval wording is mode-specific", () => {
    const fullAccessDescription = getDescription(runTerminalCmdTool);
    expect(fullAccessDescription).not.toContain("ask the user to approve it");
    expect(fullAccessDescription).toContain(
      "Use command chaining and pipes for efficiency",
    );
    expect(fullAccessDescription).toContain("append ` | cat` to the command");

    const approvalGatedTool = createRunTerminalCmdToolSchema({
      approvalGated: true,
    });
    const approvalGatedDescription = getDescription(approvalGatedTool);

    expect(approvalGatedDescription).toContain(
      "The platform will pause execution after you call this tool and ask the user to approve it",
    );
    expect(approvalGatedDescription).toContain(
      "Prefer one static command per tool call",
    );
    expect(approvalGatedDescription).toContain(
      "HackerAI displays it in the approval prompt",
    );
    expect(approvalGatedDescription).toContain(
      "Prefer a stable safe prefix over copying the complete command",
    );
    expect(approvalGatedDescription).toContain(
      "Never provide prefix_rule for destructive commands",
    );
    expect(approvalGatedDescription).not.toContain(
      "Use command chaining and pipes for efficiency",
    );
    expect(approvalGatedDescription).not.toContain(
      "append ` | cat` to the command",
    );
    expect(getInputShape(approvalGatedTool)).toHaveProperty("justification");
    expect(getInputShape(approvalGatedTool)).toHaveProperty("prefix_rule");
    expect(getInputShape(approvalGatedTool).justification).toHaveProperty(
      "description",
      "A concise, user-facing reason shown in HackerAI's approval prompt. Explain the intended outcome rather than repeating the command.",
    );
    expect(getInputShape(approvalGatedTool).prefix_rule).toHaveProperty(
      "description",
      expect.stringContaining("separate argv elements"),
    );
    expect(getInputShape(runTerminalCmdTool)).not.toHaveProperty(
      "justification",
    );
    expect(getInputShape(runTerminalCmdTool)).not.toHaveProperty("prefix_rule");
  });

  test("file approval wording is only included for approval-gated schemas", () => {
    const fullAccessTool = createFileToolSchema({ supportsView: true });
    const approvalGatedTool = createFileToolSchema({
      supportsView: true,
      approvalGated: true,
    });

    expect(getDescription(fullAccessTool)).not.toContain("approval-gated");
    expect(getDescription(approvalGatedTool)).toContain(
      "Write, append, and edit actions are approval-gated.",
    );
    expect(getDescription(fullAccessTool)).toContain(
      "automatically routes subsequent Agent steps to a vision-capable model",
    );
  });

  test("always exposes image view in the Agent schema catalog", () => {
    const agentTools = createAgentToolSchemaSet();
    const fileInputShape = getInputShape(agentTools.file);
    const actionSchema = fileInputShape.action as {
      safeParse: (input: unknown) => { success: boolean };
    };

    expect(actionSchema.safeParse("view").success).toBe(true);
    expect(createAgentToolSchemaSet({ mode: "ask" })).not.toHaveProperty(
      "file",
    );
  });
});
