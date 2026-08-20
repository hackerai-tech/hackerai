import { isEligibleForAuxiliaryDeepSeekVision } from "@/lib/chat/auxiliary-vision-eligibility";

describe("auxiliary DeepSeek vision eligibility", () => {
  it("enables paid non-Max routes by default", () => {
    expect(isEligibleForAuxiliaryDeepSeekVision({ subscription: "pro" })).toBe(
      true,
    );
    expect(
      isEligibleForAuxiliaryDeepSeekVision({
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
      }),
    ).toBe(false);
    expect(isEligibleForAuxiliaryDeepSeekVision({ subscription: "free" })).toBe(
      false,
    );
  });
});
