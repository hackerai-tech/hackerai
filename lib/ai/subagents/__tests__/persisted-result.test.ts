import { describe, expect, it } from "@jest/globals";
import { resultFromPersistedSubagent } from "../persisted-result";

describe("resultFromPersistedSubagent", () => {
  it("preserves a valid bounded terminal result", () => {
    expect(
      resultFromPersistedSubagent({
        status: "completed",
        structured_result: {
          verdict: "rejected",
          confidence: "high",
          summary: "The candidate did not reproduce.",
          reproduction_steps: ["Attempted the supplied request."],
          evidence_refs: ["terminal:attempt-1"],
          limitations: ["Validated in the supplied sandbox."],
          recommended_severity: "info",
        },
      }),
    ).toEqual({
      status: "completed",
      verdict: "rejected",
      confidence: "high",
      summary: "The candidate did not reproduce.",
      reproduction_steps: ["Attempted the supplied request."],
      evidence_refs: ["terminal:attempt-1"],
      limitations: ["Validated in the supplied sandbox."],
      recommended_severity: "info",
    });
  });

  it("bounds malformed persisted values instead of throwing", () => {
    const result = resultFromPersistedSubagent({
      status: "failed",
      summary: "fallback summary",
      verdict: "unexpected",
      confidence: 42,
      structured_result: {
        summary: "x".repeat(3_000),
        evidence_refs: ["e".repeat(700), null, 42],
        limitations: "not-an-array",
        recommended_severity: "urgent",
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      verdict: null,
      confidence: null,
      recommended_severity: null,
      limitations: [],
    });
    expect(result.summary).toHaveLength(2_000);
    expect(result.evidence_refs).toHaveLength(1);
    expect(result.evidence_refs[0]).toHaveLength(500);
  });
});
