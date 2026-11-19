import {
  agentRetestResultKey,
  containsLikelySecret,
  parseAgentRetestResult,
} from "../agent-retest";

const result = (overrides: Record<string, unknown> = {}) => ({
  outcome: "not_reproduced",
  summary: "The tester's own invoice loaded; the other account's was denied.",
  reproduction_steps: ["Load own invoice", "Load other invoice"],
  expected_result: "403 for the other account's invoice",
  observed_result: "Own invoice 200; other invoice 403",
  evidence_refs: [],
  limitations: ["Only one invoice pair was checked."],
  ...overrides,
});

describe("Agent retest result rules", () => {
  it("requires a stated limitation unless the issue reproduced", () => {
    for (const outcome of ["not_reproduced", "inconclusive"])
      expect(
        parseAgentRetestResult(result({ outcome, limitations: [] })),
      ).toMatchObject({ success: false, message: /limitations/ });
    expect(
      parseAgentRetestResult(
        result({ outcome: "reproduced", limitations: [] }),
      ),
    ).toMatchObject({ success: true });
  });

  it("rejects unredacted credentials anywhere but allows labelled redactions", () => {
    const secrets = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Basic dGVzdDpzeW50aGV0aWM=",
      "Proxy-Authorization: Basic dGVzdDpzeW50aGV0aWM=",
      "Authorization: Token synthetic-credential-value",
      'Authorization: Digest username="synthetic-user", response="synthetic-response"',
      "Authorization: ApiKey synthetic-credential-value",
      "Cookie: session=4f9a8b7c6d5e4f3a2b1c",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
      "-----BEGIN RSA PRIVATE KEY-----",
    ];
    for (const secret of secrets) {
      expect(containsLikelySecret(secret)).toBe(true);
      expect(
        parseAgentRetestResult(result({ observed_result: `200 ${secret}` })),
      ).toMatchObject({ success: false });
      expect(
        parseAgentRetestResult(result({ limitations: [secret] })),
      ).toMatchObject({ success: false });
    }
    expect(
      parseAgentRetestResult(
        result({
          observed_result:
            "Sent Authorization: Bearer [REDACTED] and Cookie: [REDACTED]",
        }),
      ),
    ).toMatchObject({ success: true });
    for (const scheme of ["Basic", "Token", "Digest", "Negotiate"]) {
      expect(
        parseAgentRetestResult(
          result({
            observed_result: `Sent Authorization: ${scheme} [REDACTED]`,
          }),
        ),
      ).toMatchObject({ success: true });
    }
  });

  it("bounds field sizes and rejects unknown fields", () => {
    expect(
      parseAgentRetestResult(result({ summary: "x".repeat(601) })),
    ).toMatchObject({ success: false });
    expect(
      parseAgentRetestResult(
        result({ reproduction_steps: Array(13).fill("step") }),
      ),
    ).toMatchObject({ success: false });
    expect(
      parseAgentRetestResult(result({ finding_status: "closed" })),
    ).toMatchObject({ success: false });
  });

  it("compares retries by content, not evidence order", () => {
    const parsed = parseAgentRetestResult(result());
    if (!parsed.success) throw new Error(parsed.message);
    expect(agentRetestResultKey(parsed.result, ["/b", "/a"])).toBe(
      agentRetestResultKey(parsed.result, ["/a", "/b", "/a"]),
    );
    expect(
      agentRetestResultKey({ ...parsed.result, outcome: "inconclusive" }, [
        "/a",
        "/b",
      ]),
    ).not.toBe(agentRetestResultKey(parsed.result, ["/a", "/b"]));
  });
});
