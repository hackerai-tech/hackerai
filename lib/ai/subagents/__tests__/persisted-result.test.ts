import { describe, expect, it } from "@jest/globals";
import { resultFromPersistedSubagent } from "../persisted-result";

describe("resultFromPersistedSubagent", () => {
  it("preserves a valid bounded terminal result", () => {
    expect(
      resultFromPersistedSubagent({
        profile: "security_validation",
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
      profile: "security_validation",
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
      profile: "security_validation",
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

  it("preserves a bounded generic security task result", () => {
    expect(
      resultFromPersistedSubagent({
        profile: "security_task",
        status: "completed",
        structured_result: {
          task_status: "partial",
          summary: "Inspected the supplied artifact.",
          evidence_refs: ["file:/tmp/sample.json"],
          artifacts: [{ path: "/tmp/findings.md", description: "Notes" }],
          limitations: ["No live target access."],
          next_steps: ["Validate the suspicious request."],
          coverage: [
            {
              surface: "Uploaded request artifact",
              risk_area: "Authorization",
              outcome: "A suspicious ownership check was identified.",
              evidence_refs: ["file:/tmp/sample.json"],
            },
          ],
        },
      }),
    ).toEqual({
      profile: "security_task",
      status: "completed",
      task_status: "partial",
      summary: "Inspected the supplied artifact.",
      evidence_refs: ["file:/tmp/sample.json"],
      artifacts: [{ path: "/tmp/findings.md", description: "Notes" }],
      limitations: ["No live target access."],
      next_steps: ["Validate the suspicious request."],
      coverage: [
        {
          surface: "Uploaded request artifact",
          risk_area: "Authorization",
          outcome: "A suspicious ownership check was identified.",
          evidence_refs: ["file:/tmp/sample.json"],
        },
      ],
    });
  });

  it("drops malformed coverage entries and caps the parent-visible result", () => {
    const result = resultFromPersistedSubagent({
      profile: "security_task",
      status: "completed",
      structured_result: {
        task_status: "completed",
        summary: "Reviewed the assigned surfaces.",
        evidence_refs: [],
        artifacts: [],
        limitations: [],
        next_steps: [],
        coverage: [
          {
            surface: "",
            risk_area: "Authorization",
            outcome: "Invalid because the surface is empty.",
            evidence_refs: ["file:/tmp/invalid.txt"],
          },
          ...Array.from({ length: 9 }, (_, index) => ({
            surface: `Surface ${index}`,
            risk_area: "Authorization",
            outcome: "No issue identified in the reviewed path.",
            evidence_refs: [`file:/tmp/evidence-${index}.txt`],
          })),
        ],
      },
    });

    expect(result).toMatchObject({
      profile: "security_task",
      coverage: expect.arrayContaining([
        expect.objectContaining({ surface: "Surface 0" }),
      ]),
    });
    expect(
      result.profile === "security_task" ? result.coverage : undefined,
    ).toHaveLength(8);
    const exposedCoverage =
      result.profile === "security_task" ? (result.coverage ?? []) : [];
    expect(exposedCoverage.every((entry) => entry.surface.length > 0)).toBe(
      true,
    );
  });
});
