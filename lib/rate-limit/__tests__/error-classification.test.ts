import { describe, expect, it } from "@jest/globals";

import { ChatSDKError } from "@/lib/errors";
import { isHandledUserRateLimitError } from "../error-classification";

describe("isHandledUserRateLimitError", () => {
  it("handles user quota exhaustion", () => {
    expect(
      isHandledUserRateLimitError(
        new ChatSDKError("rate_limit:chat", "Daily requests exhausted", {
          capReason: "daily_requests_exhausted",
        }),
      ),
    ).toBe(true);
  });

  it("fails closed for unknown chat rate-limit errors", () => {
    expect(
      isHandledUserRateLimitError(
        new ChatSDKError(
          "rate_limit:chat",
          "Current billing authorization could not be verified",
        ),
      ),
    ).toBe(false);
  });

  it("does not handle explicitly operational cap reasons", () => {
    expect(
      isHandledUserRateLimitError(
        new ChatSDKError("rate_limit:chat", "Billing unavailable", {
          capReason: "billing_unavailable",
        }),
      ),
    ).toBe(false);
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
