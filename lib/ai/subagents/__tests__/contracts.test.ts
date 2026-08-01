import { describe, expect, it } from "@jest/globals";

import {
  MAX_SUBAGENT_CONTEXT_REFS,
  delegateTaskInputSchema,
  isSeverityAtMost,
  securityValidationResultSchema,
} from "../contracts";

const candidate = {
  title: "Stored XSS in profile name",
  affected_asset: "https://example.test/profile",
  weakness_class: "CWE-79",
  claimed_impact: "Arbitrary JavaScript executes in another user's session.",
};

describe("subagent contracts", () => {
  it("accepts only the v1 security validation profile and wait behavior", () => {
    const valid = delegateTaskInputSchema.parse({
      objective: "Independently reproduce the candidate.",
      profile: "security_validation",
      profile_input: { candidate },
      context_refs: [],
      wait_behavior: "wait_for_result",
    });
    expect(valid.profile).toBe("security_validation");

    expect(() =>
      delegateTaskInputSchema.parse({
        ...valid,
        profile: "recon",
      }),
    ).toThrow();
    expect(() =>
      delegateTaskInputSchema.parse({
        ...valid,
        wait_behavior: "fire_and_forget",
      }),
    ).toThrow();
  });

  it("caps context references and requires evidence for confirmed verdicts", () => {
    expect(() =>
      delegateTaskInputSchema.parse({
        objective: "Validate",
        profile: "security_validation",
        profile_input: { candidate },
        context_refs: Array.from(
          { length: MAX_SUBAGENT_CONTEXT_REFS + 1 },
          (_, index) => ({
            kind: "sandbox_file",
            path: `/tmp/evidence-${index}.txt`,
          }),
        ),
        wait_behavior: "wait_for_result",
      }),
    ).toThrow();

    expect(() =>
      securityValidationResultSchema.parse({
        verdict: "confirmed",
        confidence: "high",
        summary: "Confirmed",
        reproduction_steps: [],
        evidence_refs: [],
        limitations: [],
        recommended_severity: "high",
      }),
    ).toThrow(/requires at least one reproduction step/i);
  });

  it("prevents report severity from exceeding the child recommendation", () => {
    expect(isSeverityAtMost("high", "high")).toBe(true);
    expect(isSeverityAtMost("medium", "high")).toBe(true);
    expect(isSeverityAtMost("critical", "high")).toBe(false);
  });
});
