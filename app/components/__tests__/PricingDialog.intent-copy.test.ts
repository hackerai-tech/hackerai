import { describe, expect, it } from "@jest/globals";
import { getPricingIntentCopy } from "../PricingDialog";

describe("getPricingIntentCopy", () => {
  it("uses generic copy for non-Agent limit pressure", () => {
    const copy = getPricingIntentCopy(
      {
        source: "limit_pressure",
        limitType: "free_monthly",
        reason: "free_monthly_exhausted",
      },
      "free",
    );

    expect(copy).toEqual(
      expect.objectContaining({
        title: "Keep working",
        description: expect.stringContaining("higher usage limits"),
        proDescription: "Continue with higher limits",
      }),
    );
    expect(copy?.title).not.toContain("Agent");
    expect(copy?.description).not.toContain("Agent");
    expect(copy?.proDescription).not.toContain("Agent");
  });

  it("keeps Agent-specific copy for the Agent gate", () => {
    const copy = getPricingIntentCopy(
      {
        source: "agent_mode_gate",
      },
      "free",
    );

    expect(copy).toEqual(
      expect.objectContaining({
        title: "Unlock cloud Agent mode",
        proButtonText: "Use cloud Agent",
      }),
    );
  });
});
