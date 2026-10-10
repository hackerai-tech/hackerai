import { sanitizeFindingPartsForShare } from "../share-sanitizer";

const privateInput = {
  title: "Cross-tenant invoice access",
  target: "app.example.test",
  evidence: "secret response body",
  technical_analysis: "private source analysis",
  poc_script_code: "curl secret",
  cve: "CVE-2026-12345",
  cwe: "CWE-639",
  code_locations: [{ file: "secret.ts", start_line: 1, end_line: 2 }],
};

describe("public finding sanitizer", () => {
  it("replaces a successful tool part with compact safe metadata", () => {
    const [part] = sanitizeFindingPartsForShare([
      {
        type: "tool-create_vulnerability_report",
        toolCallId: "private-tool-id",
        state: "output-available",
        input: privateInput,
        output: {
          success: true,
          finding_id: "private-finding-id",
          title: privateInput.title,
          target: privateInput.target,
          endpoint: "/api/invoices/123",
          severity: "high",
          cvss_score: 8.1,
        },
      },
    ]);

    expect(part).toEqual({
      type: "data-shared-finding",
      data: {
        title: privateInput.title,
        target: privateInput.target,
        severity: "high",
        cvss_score: 8.1,
      },
    });
    expect(JSON.stringify(part)).not.toMatch(
      /private-tool-id|private-finding-id|secret|evidence|technical_analysis|poc|code_locations|CVE|CWE|endpoint/,
    );
  });

  it("drops failed, streaming, and dynamic finding tool parts", () => {
    expect(
      sanitizeFindingPartsForShare([
        {
          type: "tool-create_vulnerability_report",
          state: "output-available",
          input: privateInput,
          output: { success: false, error: "validation" },
        },
        {
          type: "tool-create_vulnerability_report",
          state: "input-available",
          input: privateInput,
        },
        {
          type: "dynamic-tool",
          toolName: "create_vulnerability_report",
          input: privateInput,
        },
      ]),
    ).toEqual([]);
  });

  it("never falls back to private input when compact output metadata is missing", () => {
    expect(
      sanitizeFindingPartsForShare([
        {
          type: "tool-create_vulnerability_report",
          state: "output-available",
          input: privateInput,
          output: {
            success: true,
            severity: "high",
            cvss_score: 8.1,
          },
        },
      ]),
    ).toEqual([]);
  });

  it("preserves unrelated message parts", () => {
    const text = { type: "text", text: "Public explanation" };
    expect(sanitizeFindingPartsForShare([text])).toEqual([text]);
  });

  it("scrubs payload-bearing validation errors from unrelated tools", () => {
    const [part] = sanitizeFindingPartsForShare([
      {
        type: "tool-http_request",
        toolCallId: "request-1",
        state: "output-error",
        input: { url: "https://example.test" },
        errorText:
          'Invalid input for tool http_request: Type validation failed: Value: {"auth":{"password":"private"}}',
      },
    ]);

    expect(part).toMatchObject({
      type: "tool-http_request",
      state: "output-error",
      errorText: "Some tool parameters did not match the required format.",
    });
    expect(part.errorText).not.toMatch(/password|private|Value:/);
  });
});

it("drops private report reads/lists and sanitizes update inputs from shares and forks", () => {
  const parts = [
    {
      type: "tool-get_report",
      toolCallId: "private-id",
      state: "output-available",
      output: { success: true, report: privateInput },
    },
    {
      type: "tool-list_reports",
      state: "output-available",
      output: {
        success: true,
        reports: [{ finding_id: "private-id", ...privateInput }],
      },
    },
    {
      type: "tool-update_vulnerability_report",
      input: {
        finding_id: "private-id",
        reason: "secret correction",
        changes: privateInput,
      },
      output: {
        success: true,
        finding_id: "private-id",
        title: "Corrected report",
        target: "app.example.test",
        severity: "high",
        cvss_score: 7.1,
      },
    },
    ...["list_reports", "get_report", "update_vulnerability_report"].map(
      (toolName) => ({
        type: "dynamic-tool",
        toolName,
        input: privateInput,
        output: privateInput,
      }),
    ),
  ];
  expect(sanitizeFindingPartsForShare(parts)).toEqual([
    {
      type: "data-shared-finding",
      data: {
        title: "Corrected report",
        target: "app.example.test",
        severity: "high",
        cvss_score: 7.1,
      },
    },
  ]);
  expect(JSON.stringify(sanitizeFindingPartsForShare(parts))).not.toMatch(
    /secret|private-id|evidence|changes|reason/,
  );
});
