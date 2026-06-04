import { describe, expect, it } from "@jest/globals";
import {
  getMaxTokensForSubscription,
  MAX_TOKENS_FREE,
  MAX_TOKENS_PAID,
  safeCountTokens,
  safeEncode,
  sliceByTokens,
  truncateContent,
} from "@/lib/token-utils";

describe("getMaxTokensForSubscription", () => {
  it("uses the 128k cap for free users", () => {
    expect(MAX_TOKENS_FREE).toBe(128000);
    expect(getMaxTokensForSubscription("free")).toBe(128000);
  });

  it("uses the paid cap for paid users and unknown subscriptions", () => {
    expect(getMaxTokensForSubscription("pro")).toBe(MAX_TOKENS_PAID);
    expect(getMaxTokensForSubscription("pro-plus")).toBe(MAX_TOKENS_PAID);
    expect(getMaxTokensForSubscription("ultra")).toBe(MAX_TOKENS_PAID);
    expect(getMaxTokensForSubscription("team")).toBe(MAX_TOKENS_PAID);
    expect(getMaxTokensForSubscription()).toBe(MAX_TOKENS_PAID);
  });
});

describe("special token sentinels", () => {
  it("counts reserved tokenizer sentinels as plain text", () => {
    expect(() =>
      safeCountTokens("literal <|im_start|> sentinel"),
    ).not.toThrow();
  });

  it("encodes reserved tokenizer sentinels as plain text", () => {
    expect(() => safeEncode("literal <|im_start|> sentinel")).not.toThrow();
  });

  it("preserves reserved tokenizer sentinel text when slicing", () => {
    const content = "prefix <|im_start|> suffix ".repeat(20);

    expect(sliceByTokens(content, 20)).not.toContain("<\\|");
  });

  it("preserves reserved tokenizer sentinel text when truncating", () => {
    const content = `prefix <|im_start|> ${"middle ".repeat(200)}suffix <|im_end|>`;
    const truncated = truncateContent(content, "\n[truncated]\n", 20);

    expect(truncated).toContain("<|im_end|>");
    expect(truncated).not.toContain("<\\|");
  });
});
