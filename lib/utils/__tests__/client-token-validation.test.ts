import { describe, expect, it } from "@jest/globals";
import {
  getInputTokenLimitStatus,
  inputTokenCountCouldExceedLimit,
} from "@/lib/utils/client-token-validation";

describe("getInputTokenLimitStatus", () => {
  it("accepts inputs whose UTF-8 byte upper bound fits the token budget", async () => {
    expect(
      inputTokenCountCouldExceedLimit("ordinary chat message", [], 128000),
    ).toBe(false);
    await expect(
      getInputTokenLimitStatus("ordinary chat message", [], 128000),
    ).resolves.toEqual({ exceedsLimit: false });
  });

  it("uses the exact tokenizer instead of rejecting multibyte text early", async () => {
    expect(inputTokenCountCouldExceedLimit("é", [], 1)).toBe(true);
    await expect(getInputTokenLimitStatus("é", [], 1)).resolves.toEqual({
      exceedsLimit: false,
    });
  });

  it("reports the exact token count when text exceeds the limit", async () => {
    const result = await getInputTokenLimitStatus("hello world", [], 1);

    expect(result.exceedsLimit).toBe(true);
    if (result.exceedsLimit) {
      expect(result.tokenCount).toBeGreaterThan(1);
    }
  });

  it("includes uploaded file tokens in the limit", async () => {
    await expect(
      getInputTokenLimitStatus("", [{ tokens: 2 }], 1),
    ).resolves.toEqual({ exceedsLimit: true, tokenCount: 2 });
  });
});
