import {
  isAgentAutoContinueUsageProtectionEligible,
  resolveAgentAutoContinueUsageProtectionAssignment,
} from "../agent-auto-continue-usage-protection";

describe("agent auto-continue usage protection", () => {
  it("limits eligibility to paid automatic continuations", () => {
    expect(
      isAgentAutoContinueUsageProtectionEligible({
        subscription: "pro",
        isAutomaticContinuation: true,
      }),
    ).toBe(true);
    expect(
      isAgentAutoContinueUsageProtectionEligible({
        subscription: "free",
        isAutomaticContinuation: true,
      }),
    ).toBe(false);
    expect(
      isAgentAutoContinueUsageProtectionEligible({
        subscription: "ultra",
        isAutomaticContinuation: false,
      }),
    ).toBe(false);
  });

  it("preserves unavailable flag evaluations instead of treating them as control", () => {
    expect(resolveAgentAutoContinueUsageProtectionAssignment(true)).toBe(
      "test",
    );
    expect(resolveAgentAutoContinueUsageProtectionAssignment(false)).toBe(
      "control",
    );
    expect(resolveAgentAutoContinueUsageProtectionAssignment(null)).toBe(
      undefined,
    );
  });
});
