import { describe, it, expect, afterEach, jest } from "@jest/globals";

import {
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

  it("does not match other AuthKit callback errors", () => {
    expect(
      isRecoverableAuthkitCallbackErrorLog([
        "[AuthKit callback error]",
        new Error("OAuth state mismatch"),
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
