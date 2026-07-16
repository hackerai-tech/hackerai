import fs from "node:fs";
import path from "node:path";
import { sanitizeFindingPartsForShare } from "../../lib/findings/share-sanitizer";

describe("shared finding security boundary", () => {
  it("sanitizes both public reads and shared-chat forks on the server", () => {
    const messagesSource = fs.readFileSync(
      path.resolve(__dirname, "../messages.ts"),
      "utf8",
    );
    const forksSource = fs.readFileSync(
      path.resolve(__dirname, "../sharedChats.ts"),
      "utf8",
    );

    for (const source of [messagesSource, forksSource]) {
      expect(source).toMatch(/sanitizeFindingPartsForShare\(/);
    }
  });

  it("never retains private input or internal identifiers in a forkable part", () => {
    const serialized = JSON.stringify(
      sanitizeFindingPartsForShare([
        {
          type: "tool-create_vulnerability_report",
          toolCallId: "tool-secret",
          state: "output-available",
          input: {
            title: "Confirmed IDOR",
            target: "app.example.test",
            evidence: "private evidence",
            technical_analysis: "private analysis",
            poc_script_code: "private exploit",
            cve: "CVE-2026-12345",
            cwe: "CWE-639",
            code_locations: [{ file: "private.ts" }],
          },
          output: {
            success: true,
            finding_id: "finding-secret",
            title: "Confirmed IDOR",
            target: "app.example.test",
            severity: "high",
            cvss_score: 7.1,
          },
        },
      ]),
    );

    expect(serialized).toBe(
      JSON.stringify([
        {
          type: "data-shared-finding",
          data: {
            title: "Confirmed IDOR",
            target: "app.example.test",
            severity: "high",
            cvss_score: 7.1,
          },
        },
      ]),
    );
    expect(serialized).not.toMatch(
      /tool-secret|finding-secret|private evidence|private analysis|private exploit|private\.ts|CVE|CWE/,
    );
  });
});
