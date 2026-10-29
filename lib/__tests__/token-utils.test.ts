import { describe, expect, it, jest } from "@jest/globals";
import type { UIMessage } from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import { decode, encode } from "gpt-tokenizer";
import {
  getMaxTokensForSubscription,
  MAX_TOKENS_FREE,
  MAX_TOKENS_PAID,
  safeCountTokens,
  safeEncode,
  sliceByTokens,
  truncateContent,
  truncateMessagesToTokenLimit,
} from "@/lib/token-utils";

describe("empty whole-message projection diagnostics", () => {
  const newest = {
    id: "private-message",
    role: "user",
    parts: [{ type: "file", fileId: "private-file" }],
  } as unknown as UIMessage;
  const files = { ["private-file" as Id<"files">]: 101 };

  it("reports the blocking cost without retaining an over-budget message", () => {
    const observe = jest.fn();
    expect(truncateMessagesToTokenLimit([newest], files, 100, observe)).toEqual(
      [],
    );
    expect(observe).toHaveBeenCalledWith({
      budgetTokens: 100,
      newestMessageTokens: 101,
    });
  });

  it("does not report an empty projection when the newest message fits", () => {
    const observe = jest.fn();
    expect(truncateMessagesToTokenLimit([newest], files, 101, observe)).toEqual(
      [newest],
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not report an empty projection after retaining a newer message", () => {
    const observe = jest.fn();
    const smaller = {
      ...newest,
      id: "newest",
      parts: [{ type: "file", fileId: "small-file" }],
    } as unknown as UIMessage;
    expect(
      truncateMessagesToTokenLimit(
        [newest, smaller],
        { ...files, ["small-file" as Id<"files">]: 1 },
        100,
        observe,
      ),
    ).toEqual([smaller]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("preserves the empty result when optional diagnostics throw", () => {
    expect(
      truncateMessagesToTokenLimit([newest], files, 100, () => {
        throw new Error("diagnostics unavailable");
      }),
    ).toEqual([]);
  });
});

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

describe("large tokenizer batches", () => {
  it("preserves every token in a split larger than the JS argument limit", () => {
    // This is one BPE split with 150,000 tokens. gpt-tokenizer's encode()
    // spreads that batch into push(), which overflows Node's call stack.
    const content = "\u0001".repeat(150_000);
    const tokens = safeEncode(content);

    expect(tokens).toHaveLength(safeCountTokens(content));
    expect(decode(tokens)).toBe(content);
    expect(safeCountTokens(sliceByTokens(content, 20))).toBe(20);
    expect(
      safeCountTokens(truncateContent(content, "[cut]", 40)),
    ).toBeLessThanOrEqual(40);
  });

  it.each([
    "ordinary text and punctuation!\nnext line",
    "你好 🌍 café\n",
    "literal <|im_start|> sentinel <|im_end|>",
    "",
  ])("keeps exact BPE output for %j", (content) => {
    expect(safeEncode(content)).toEqual(
      encode(content, { disallowedSpecial: new Set() }),
    );
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
