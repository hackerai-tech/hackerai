import { describe, expect, it } from "@jest/globals";
import {
  getMaxTokensForSubscription,
  MAX_TOKENS_FREE,
  MAX_TOKENS_PAID,
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
