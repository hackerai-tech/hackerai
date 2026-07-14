import { describe, it, expect, afterEach, jest } from "@jest/globals";

import {
  isAuthVerifierMissingError,
  isAuthCookieMissingError,
  isMissingRequiredAuthParameterError,
  isOAuthStateMismatchError,
  isOauthCodeAlreadyExchangedError,
  isRecoverableAuthkitCallbackErrorLog,
  withRecoverableAuthkitCallbackErrorSuppressed,
} from "../authkit-callback-logging";

const originalConsoleError = console.error;

describe("authkit callback logging", () => {
  afterEach(() => {
    console.error = originalConsoleError;
    jest.restoreAllMocks();
  });

  it("matches AuthKit's recoverable missing-cookie callback error", () => {
    expect(
      isRecoverableAuthkitCallbackErrorLog([
        "[AuthKit callback error]",
        new Error(
          "Auth cookie missing - cannot verify OAuth state. Ensure Set-Cookie headers are propagated on redirects.",
        ),
      ]),
    ).toBe(true);
  });

  it("matches non-Error missing-cookie callback values", () => {
    expect(isAuthCookieMissingError("Auth cookie missing")).toBe(true);
    expect(
      isAuthCookieMissingError({
        message: "Auth cookie missing - cannot verify OAuth state.",
      }),
    ).toBe(true);
  });

  it("matches missing auth parameter callback errors", () => {
    const error = new Error("Missing required auth parameter");

    expect(isMissingRequiredAuthParameterError(error)).toBe(true);
    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("matches missing verifier schema callback errors", () => {
    const error = Object.assign(
      new Error('Invalid key: Expected "nonce" but received undefined'),
      {
        name: "ValiError",
        issues: [
          {
            expected: '"nonce"',
            received: "undefined",
          },
        ],
      },
    );

    expect(isAuthVerifierMissingError(error)).toBe(true);
    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("matches OAuth state mismatch callback errors", () => {
    const error = new Error("OAuth state mismatch");

    expect(isOAuthStateMismatchError(error)).toBe(true);
    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("does not match unrelated AuthKit callback errors", () => {
    expect(
      isRecoverableAuthkitCallbackErrorLog([
        "[AuthKit callback error]",
        new Error("OAuth provider unavailable"),
      ]),
    ).toBe(false);
  });

  it("matches already-exchanged OAuth code errors", () => {
    const error = Object.assign(
      new Error(
        "Error: invalid_grant\nError Description: The code 'abc123' has already been exchanged.",
      ),
      {
        status: 400,
        error: "invalid_grant",
        errorDescription: "The code 'abc123' has already been exchanged.",
        rawData: {
          error: "invalid_grant",
          error_description: "The code 'abc123' has already been exchanged.",
        },
      },
    );

    expect(isOauthCodeAlreadyExchangedError(error)).toBe(true);
    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("matches invalid code verifier callback errors", () => {
    const error = Object.assign(
      new Error(
        "Error: invalid_grant\nError Description: Invalid code verifier.",
      ),
      {
        status: 400,
        error: "invalid_grant",
        errorDescription: "Invalid code verifier.",
        rawData: {
          error: "invalid_grant",
          error_description: "Invalid code verifier.",
        },
      },
    );

    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("matches unverified sign-in session callback errors", () => {
    const error = new Error(
      "Sign-in session could not be verified. Please try signing in again.",
    );

    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(true);
  });

  it("does not match other invalid_grant errors", () => {
    const error = Object.assign(new Error("Error: invalid_grant"), {
      error: "invalid_grant",
      errorDescription: "The authorization code is expired.",
    });

    expect(isOauthCodeAlreadyExchangedError(error)).toBe(false);
    expect(
      isRecoverableAuthkitCallbackErrorLog(["[AuthKit callback error]", error]),
    ).toBe(false);
  });

  it("suppresses only the recoverable AuthKit error log", async () => {
    const consoleError = jest.fn();
    console.error = consoleError as typeof console.error;

    await withRecoverableAuthkitCallbackErrorSuppressed(async () => {
      console.error(
        "[AuthKit callback error]",
        new Error("Auth cookie missing - cannot verify OAuth state."),
      );
      console.error(
        "[AuthKit callback error]",
        new Error(
          "Error: invalid_grant\nError Description: The code 'abc123' has already been exchanged.",
        ),
      );
      console.error(
        "[AuthKit callback error]",
        new Error(
          "Error: invalid_grant\nError Description: Invalid code verifier.",
        ),
      );
      console.error(
        "[AuthKit callback error]",
        new Error(
          "Sign-in session could not be verified. Please try signing in again.",
        ),
      );
      console.error(
        "[AuthKit callback error]",
        new Error("Missing required auth parameter"),
      );
      console.error(
        "[AuthKit callback error]",
        new Error("OAuth state mismatch"),
      );
      console.error(
        "[AuthKit callback error]",
        Object.assign(
          new Error('Invalid key: Expected "nonce" but received undefined'),
          {
            name: "ValiError",
            issues: [
              {
                expected: '"nonce"',
                received: "undefined",
              },
            ],
          },
        ),
      );
      console.error("other error", new Error("boom"));
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("other error", expect.any(Error));
    expect(console.error).toBe(consoleError);
  });

  it("keeps the filter active for overlapping callback handlers", async () => {
    const consoleError = jest.fn();
    console.error = consoleError as typeof console.error;

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = withRecoverableAuthkitCallbackErrorSuppressed(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = withRecoverableAuthkitCallbackErrorSuppressed(
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
    );

    console.error(
      "[AuthKit callback error]",
      new Error("Auth cookie missing - cannot verify OAuth state."),
    );

    releaseFirst();
    await first;

    console.error(
      "[AuthKit callback error]",
      new Error("Auth cookie missing - cannot verify OAuth state."),
    );

    releaseSecond();
    await second;

    console.error("real error");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("real error");
    expect(console.error).toBe(consoleError);
  });
});
