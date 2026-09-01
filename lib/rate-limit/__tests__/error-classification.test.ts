import { describe, expect, it } from "@jest/globals";

import { ChatSDKError } from "@/lib/errors";
import { isHandledUserRateLimitError } from "../error-classification";

describe("isHandledUserRateLimitError", () => {
  it("handles user quota exhaustion", () => {
    expect(
      isHandledUserRateLimitError(
        new ChatSDKError("rate_limit:chat", "Daily requests exhausted"),
      ),
    ).toBe(true);
  });

  it.each([
    "Rate limiting service is not configured",
    "Rate limiting service unavailable: connection failed",
    "Extra usage billing is temporarily unavailable",
  ])("does not hide operational failure: %s", (cause) => {
    expect(
      isHandledUserRateLimitError(new ChatSDKError("rate_limit:chat", cause)),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(isHandledUserRateLimitError(new Error("rate limited"))).toBe(false);
    expect(
      isHandledUserRateLimitError(
        new ChatSDKError("rate_limit:api", "API quota exhausted"),
      ),
    ).toBe(false);
  });
});
