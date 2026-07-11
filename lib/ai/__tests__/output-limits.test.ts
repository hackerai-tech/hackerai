import { MAX_OUTPUT_TOKENS } from "../output-limits";

describe("output limits", () => {
  it("uses the shared 32k output cap for every subscription", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_000);
  });
});
