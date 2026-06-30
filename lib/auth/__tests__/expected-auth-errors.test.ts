import { describe, expect, it } from "@jest/globals";

import {
  collectAuthErrorText,
  isEndedSessionRefreshError,
  isInvalidCodeVerifierError,
} from "../expected-auth-errors";

describe("expected auth errors", () => {
  it("matches ended session refresh errors through nested causes", () => {
    const error = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
          rawData: {
            error: "invalid_grant",
            error_description: "Session has already ended.",
          },
        },
      },
    );

    expect(isEndedSessionRefreshError(error)).toBe(true);
  });

  it("does not match unrelated invalid_grant refresh errors as ended sessions", () => {
    const error = Object.assign(new Error("Error: invalid_grant"), {
      error: "invalid_grant",
      errorDescription: "Invalid code verifier.",
    });

    expect(isEndedSessionRefreshError(error)).toBe(false);
  });

  it("matches invalid code verifier errors", () => {
    const error = Object.assign(new Error("Error: invalid_grant"), {
      status: 400,
      error: "invalid_grant",
      errorDescription: "Invalid code verifier.",
      rawData: {
        error: "invalid_grant",
        error_description: "Invalid code verifier.",
      },
    });

    expect(isInvalidCodeVerifierError(error)).toBe(true);
  });

  it("collects nested auth error text without looping on cycles", () => {
    const error: Error & { cause?: unknown } = new Error("outer");
    error.cause = error;

    expect(collectAuthErrorText(error)).toContain("outer");
  });
});
