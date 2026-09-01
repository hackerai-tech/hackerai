import { getPaidDailyFreeAllowanceModel } from "@/lib/api/paid-daily-free-allowance-rescue";

describe("paid daily free allowance rescue model", () => {
  it("keeps paid Agent rescue traffic outside the GLM experiment", () => {
    expect(getPaidDailyFreeAllowanceModel("agent")).toBe(
      "model-deepseek-v4-flash-0731",
    );
  });

  it("preserves the free Ask route", () => {
    expect(getPaidDailyFreeAllowanceModel("ask")).toBe("ask-model-free");
  });
});
