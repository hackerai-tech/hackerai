import { isEligibleForDirectGlmVision } from "@/lib/chat/auxiliary-vision-eligibility";

describe("direct GLM vision eligibility", () => {
  it("enables paid non-Max routes by default", () => {
    expect(isEligibleForDirectGlmVision({ subscription: "pro" })).toBe(true);
    expect(
      isEligibleForDirectGlmVision({
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
      }),
    ).toBe(false);
    expect(isEligibleForDirectGlmVision({ subscription: "free" })).toBe(false);
  });
});
