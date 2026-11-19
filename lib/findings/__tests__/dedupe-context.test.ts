import {
  mergeFindingDedupeCandidates,
  sameFindingIdentity,
  type FindingIdentitySource,
} from "../dedupe-context";
import { createFindingDedupeKey } from "../validation";

const base: FindingIdentitySource = {
  title: "Cross-tenant invoice access",
  description: "An authenticated user can read another user's invoice.",
  impact: "A user can disclose another customer's billing address.",
  target: "https://app.example.test/Tenant/A",
  endpoint: "/api/Invoices/:id?view=Full",
  method: "GET",
  cwe: "CWE-639",
  technical_analysis:
    "InvoiceController.show loads by id without an owner check.",
  poc_description: "Request user B's invoice while signed in as user A.",
  poc_script_code: "curl -H 'Authorization: Bearer a' \\\n  /api/Invoices/b",
  remediation_steps: "Scope the invoice query to the authenticated user.",
  evidence: "The response returned user B's billing address.",
  assumptions: "Both accounts are ordinary customer accounts.",
  confidence: "high",
  counterevidence: "An owner check was absent on the tested path.",
  severity_change_conditions: "A verified owner check would rule it out.",
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
      file: "src/Invoices/show.ts",
      start_line: 20,
      end_line: 22,
      snippet: "const invoice = await db.get(id);\n  return invoice;",
    },
  ],
};

describe("strict finding identity", () => {
  it("accepts cosmetic title, CWE, method and URL scheme/host differences", () => {
    const resubmitted = {
      ...base,
      title: "  CROSS-TENANT   invoice access ",
      target: "HTTPS://APP.Example.TEST/Tenant/A",
      method: "get",
      // Saved rows store the method upper-cased; only line endings and outer
      // whitespace differ in prose and code.
      description: `  ${base.description}\r\n`,
      poc_script_code: base.poc_script_code.replace(/\n/g, "\r\n"),
    };
    expect(sameFindingIdentity(base, resubmitted)).toBe(true);
  });

  it.each<[string, Partial<FindingIdentitySource>]>([
    ["URL path case", { target: "https://app.example.test/tenant/a" }],
    ["endpoint path case", { endpoint: "/api/invoices/:id?view=Full" }],
    ["endpoint query case", { endpoint: "/api/Invoices/:id?view=full" }],
    ["non-URL target case", { target: "Example-Shop" }],
    [
      "code file case",
      {
        code_locations: [
          { ...base.code_locations![0], file: "src/invoices/show.ts" },
        ],
      },
    ],
    [
      "code line range",
      { code_locations: [{ ...base.code_locations![0], start_line: 21 }] },
    ],
    [
      "inner code whitespace",
      {
        code_locations: [
          {
            ...base.code_locations![0],
            snippet: "const invoice = await db.get(id);\n    return invoice;",
          },
        ],
      },
    ],
    ["missing code locations", { code_locations: undefined }],
    ["PoC code", { poc_script_code: "curl /api/Invoices/c" }],
    ["evidence", { evidence: "The response returned user C's address." }],
    [
      "technical analysis",
      { technical_analysis: "ReportController.show lacks an owner check." },
    ],
    ["impact", { impact: "A user can disclose another customer's tax ID." }],
    ["assessment", { confidence: "medium" }],
  ])("treats a different %s as not proven identical", (_name, change) => {
    const other = { ...base, ...change };
    // The stored coarse key cannot tell these apart where case or code differ.
    expect(sameFindingIdentity(base, other)).toBe(false);
  });

  it("folds only the host, not URL user information", () => {
    const withUser = (target: string) => ({ ...base, target });
    expect(
      sameFindingIdentity(
        withUser("https://Admin@APP.example.test/Tenant/A"),
        withUser("https://Admin@app.example.test/Tenant/A"),
      ),
    ).toBe(true);
    expect(
      sameFindingIdentity(
        withUser("https://Admin@app.example.test/Tenant/A"),
        withUser("https://admin@app.example.test/Tenant/A"),
      ),
    ).toBe(false);
  });

  it("does not depend on stored score key order", () => {
    const reordered = {
      ...base,
      cvss_breakdown: Object.fromEntries(
        Object.entries(base.cvss_breakdown).reverse(),
      ) as FindingIdentitySource["cvss_breakdown"],
    };
    expect(sameFindingIdentity(base, reordered)).toBe(true);
  });

  it("is stricter than the stored coarse key for case-distinct paths", () => {
    const lower = { ...base, endpoint: "/api/invoices/:id?view=full" };
    expect(createFindingDedupeKey(base)).toBe(createFindingDedupeKey(lower));
    expect(sameFindingIdentity(base, lower)).toBe(false);
  });
});

describe("dedupe candidate merge", () => {
  it("keeps recent order, then appends unseen group rows once", () => {
    const row = (finding_id: string) => ({ finding_id });
    expect(
      mergeFindingDedupeCandidates(
        [row("recent-2"), row("shared"), row("recent-1")],
        [row("older"), row("shared"), row("older")],
      ).map(({ finding_id }) => finding_id),
    ).toEqual(["recent-2", "shared", "recent-1", "older"]);
  });
});
