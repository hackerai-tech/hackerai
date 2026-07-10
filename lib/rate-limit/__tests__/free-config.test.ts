import { MAX_OUTPUT_TOKENS } from "../free-config";

describe("free rate limit config", () => {
  it("uses the shared 32k output cap for every subscription", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_000);
  });
});
