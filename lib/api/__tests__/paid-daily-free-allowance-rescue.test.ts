import { getPaidDailyFreeAllowanceModel } from "@/lib/api/paid-daily-free-allowance-rescue";
import { myProvider, supportsMultimodalToolResults } from "@/lib/ai/providers";
import { calculateRawModelUsageCostDollars } from "@/lib/rate-limit/token-bucket";

describe("paid daily free allowance rescue model", () => {
  it("uses the existing V4.1 Flash route for paid Agent rescue", () => {
    const model = getPaidDailyFreeAllowanceModel("agent");
    expect(myProvider.languageModel(model).modelId).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
    expect(supportsMultimodalToolResults(model)).toBe(true);
    expect(
      calculateRawModelUsageCostDollars({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        modelName: model,
      }),
    ).toBeCloseTo(1.353);
  });

  it("preserves the free Ask route", () => {
    expect(getPaidDailyFreeAllowanceModel("ask")).toBe("ask-model-free");
  });
});
