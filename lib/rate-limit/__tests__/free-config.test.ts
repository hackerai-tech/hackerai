import { FREE_MAX_OUTPUT_TOKENS, PAID_MAX_OUTPUT_TOKENS } from "../free-config";

describe("free rate limit config", () => {
  it("sets the free max output cap to half the paid cap", () => {
    expect(PAID_MAX_OUTPUT_TOKENS).toBe(30000);
    expect(FREE_MAX_OUTPUT_TOKENS).toBe(PAID_MAX_OUTPUT_TOKENS / 2);
  });
});
