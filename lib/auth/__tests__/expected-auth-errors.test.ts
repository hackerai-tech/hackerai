import { describe, expect, it } from "@jest/globals";

import {
  collectAuthErrorText,
  isEndedSessionRefreshError,
  isInvalidRefreshTokenError,
  isInvalidCodeVerifierError,
  isUnverifiedSignInSessionError,
} from "../expected-auth-errors";

describe("expected auth errors", () => {
  it("recovers only an exact terminal invalid refresh token and keeps it out of ended-session filtering", () => {
    const cause = {
      status: 400,
      error: "invalid_grant",
      errorDescription: "Invalid refresh token.",
    };
    const wrapped = { name: "TokenRefreshError", isTransient: false, cause };
    expect(isInvalidRefreshTokenError(cause)).toBe(true);
    expect(isInvalidRefreshTokenError(wrapped)).toBe(true);
    expect(isEndedSessionRefreshError(wrapped)).toBe(false);
    for (const error of [
      { ...wrapped, isTransient: true },
      { ...wrapped, isTransient: undefined },
      { ...cause, status: 429 },
      { ...cause, status: 500 },
      { ...cause, error: "invalid_client" },
      { ...cause, errorDescription: "Invalid code verifier." },
      { ...cause, errorDescription: "Unknown invalid refresh token." },
      new Error("invalid_grant Invalid refresh token."),
    ])
      expect(isInvalidRefreshTokenError(error)).toBe(false);
  });
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

  it("matches inactivity-ended session refresh errors", () => {
    const error = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session ended due to inactivity.",
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

  it("matches unverified sign-in session errors", () => {
    const error = new Error(
      "Sign-in session could not be verified. Please try signing in again.",
    );

    expect(isUnverifiedSignInSessionError(error)).toBe(true);
  });

  it("collects nested auth error text without looping on cycles", () => {
    const error: Error & { cause?: unknown } = new Error("outer");
    error.cause = error;

    expect(collectAuthErrorText(error)).toContain("outer");
  });
});
