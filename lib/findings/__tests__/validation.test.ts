import {
  createFindingDedupeKey,
  createFindingSearchText,
  createVulnerabilityReportInputSchema,
  type CreateVulnerabilityReportInput,
} from "../validation";

const validReport = (): CreateVulnerabilityReportInput => ({
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
  poc_script_code:
    "curl -H 'Authorization: Bearer user-a' /api/invoices/user-b",
  remediation_steps: "Scope the invoice query to the authenticated account.",
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
      end_line: 20,
      snippet: "db.invoice.findUnique({ where: { id } })",
      label: "Missing owner predicate",
      fix_before: "where: { id }",
      fix_after: "where: { id, userId }",
    },
  ],
});

describe("structured finding validation", () => {
  it("accepts a complete report", () => {
    expect(createVulnerabilityReportInputSchema.parse(validReport())).toEqual(
      validReport(),
    );
  });

  test.each([
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
  ] as const)("requires %s", (field) => {
    const report = validReport() as Record<string, unknown>;
    delete report[field];
    expect(createVulnerabilityReportInputSchema.safeParse(report).success).toBe(
      false,
    );
  });

  test.each([
    "attack_vector",
    "attack_complexity",
    "privileges_required",
    "user_interaction",
    "scope",
    "confidentiality",
    "integrity",
    "availability",
  ] as const)("requires CVSS metric %s", (metric) => {
    const report = validReport() as any;
    delete report.cvss_breakdown[metric];
    expect(createVulnerabilityReportInputSchema.safeParse(report).success).toBe(
      false,
    );
  });

  test.each([
    ["cve", "2026-1234"],
    ["cve", "CVE-26-1234"],
    ["cwe", "639"],
    ["cwe", "CWE-name"],
  ])("rejects invalid %s format", (field, value) => {
    expect(
      createVulnerabilityReportInputSchema.safeParse({
        ...validReport(),
        [field]: value,
      }).success,
    ).toBe(false);
  });

  test.each(["endpoint", "method", "cve", "cwe"] as const)(
    "normalizes a blank or null optional %s to an omitted value",
    (field) => {
      for (const value of ["   ", null]) {
        const parsed = createVulnerabilityReportInputSchema.parse({
          ...validReport(),
          [field]: value,
        });

        expect(parsed[field]).toBeUndefined();
      }
    },
  );

  it("normalizes null and blank optional code-location values", () => {
    const parsed = createVulnerabilityReportInputSchema.parse({
      ...validReport(),
      code_locations: [
        {
          file: "src/a.ts",
          start_line: 1,
          end_line: 1,
          snippet: "   ",
          label: null,
          fix_before: "",
          fix_after: null,
        },
      ],
    });
    const location = parsed.code_locations?.[0];

    expect(location?.snippet).toBeUndefined();
    expect(location?.label).toBeUndefined();
    expect(location?.fix_before).toBeUndefined();
    expect(location?.fix_after).toBeUndefined();
  });

  it("normalizes a null optional code-location list", () => {
    const parsed = createVulnerabilityReportInputSchema.parse({
      ...validReport(),
      code_locations: null,
    });

    expect(parsed.code_locations).toBeUndefined();
  });

  test.each([
    "/etc/passwd",
    "../secret.ts",
    "src/../../secret.ts",
    "src\\secret.ts",
    "C:/secret.ts",
    "src//secret.ts",
  ])("rejects unsafe code path %s", (file) => {
    expect(
      createVulnerabilityReportInputSchema.safeParse({
        ...validReport(),
        code_locations: [{ file, start_line: 1, end_line: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive and reversed line ranges", () => {
    for (const location of [
      { file: "src/a.ts", start_line: 0, end_line: 1 },
      { file: "src/a.ts", start_line: 4, end_line: 3 },
    ]) {
      expect(
        createVulnerabilityReportInputSchema.safeParse({
          ...validReport(),
          code_locations: [location],
        }).success,
      ).toBe(false);
    }
  });

  it("requires fix_before and fix_after together", () => {
    expect(
      createVulnerabilityReportInputSchema.safeParse({
        ...validReport(),
        code_locations: [
          {
            file: "src/a.ts",
            start_line: 1,
            end_line: 1,
            fix_before: "unsafe()",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires fix_before to match the declared line range", () => {
    expect(
      createVulnerabilityReportInputSchema.safeParse({
        ...validReport(),
        code_locations: [
          {
            file: "src/a.ts",
            start_line: 4,
            end_line: 5,
            fix_before: "unsafe()",
            fix_after: "safe()",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("preserves code indentation while removing boundary newlines", () => {
    const parsed = createVulnerabilityReportInputSchema.parse({
      ...validReport(),
      poc_script_code: "\n  if vulnerable:\n    exploit()\n",
      code_locations: [
        {
          file: "src/a.py",
          start_line: 4,
          end_line: 5,
          fix_before: "\n  unsafe()\n  return value\n",
          fix_after: "\n  safe()\n  return value\n",
        },
      ],
    });

    expect(parsed.poc_script_code).toBe("  if vulnerable:\n    exploit()");
    expect(parsed.code_locations?.[0].fix_before).toBe(
      "  unsafe()\n  return value",
    );
  });

  it("rejects empty required text after trimming", () => {
    expect(
      createVulnerabilityReportInputSchema.safeParse({
        ...validReport(),
        evidence: "   ",
      }).success,
    ).toBe(false);
  });

  it("rejects a report above the total payload limit", () => {
    const code_locations = Array.from({ length: 10 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      start_line: 1,
      end_line: 2,
      snippet: "x".repeat(15_000),
    }));

    const result = createVulnerabilityReportInputSchema.safeParse({
      ...validReport(),
      code_locations,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("131072 bytes"),
          }),
        ]),
      );
    }
  });

  it("normalizes same-chat fingerprint fields deterministically", () => {
    const first = validReport();
    const second = {
      ...first,
      title: "  CROSS-TENANT   invoice access ",
      target: "HTTPS://APP.EXAMPLE.TEST",
      method: "get",
      cwe: "cwe-639",
    };

    expect(createFindingDedupeKey(first)).toBe(createFindingDedupeKey(second));
  });

  it("indexes only the approved searchable metadata", () => {
    const report = validReport();
    const searchText = createFindingSearchText(report);
    expect(searchText).toContain(report.title);
    expect(searchText).toContain(report.target);
    expect(searchText).toContain(report.endpoint);
    expect(searchText).toContain(report.cve);
    expect(searchText).toContain(report.cwe);
    expect(searchText).not.toContain(report.evidence);
  });
});
