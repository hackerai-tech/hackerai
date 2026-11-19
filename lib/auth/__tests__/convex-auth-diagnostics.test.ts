import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  advanceConvexAuthTokenDecisionContext,
  beginConvexAuthTokenDecision,
  createConvexAuthTokenDecisionOwner,
  deriveConvexAuthProviderState,
  publishConvexAuthProviderState,
  readClosedConvexAuthTokenDecision,
  readConvexAuthProviderState,
  readConvexAuthTokenDecision,
} from "../convex-auth-diagnostics";

// Only the closed fields that may reach analytics.
function closedDecision() {
  const { attempt: _attempt, ...fields } = readClosedConvexAuthTokenDecision(
    readConvexAuthTokenDecision,
  );
  return fields;
}

describe("Convex auth provider diagnostics", () => {
  it.each([
    [false, false, false, "owner_absent"],
    [false, true, false, "owner_absent"],
    [false, false, true, "owner_absent"],
    [false, true, true, "owner_absent"],
    [true, false, false, "ready"],
    [true, true, false, "authkit_loading"],
    [true, false, true, "token_recovery"],
    [true, true, true, "authkit_loading_and_token_recovery"],
  ] as const)(
    "owner=%s authKitLoading=%s tokenRecovering=%s is %s",
    (ownerPresent, authKitLoading, tokenRecovering, expected) => {
      expect(
        deriveConvexAuthProviderState({
          ownerPresent,
          authKitLoading,
          tokenRecovering,
        }),
      ).toBe(expected);
    },
  );

  it("lets only the current owner clear, even when an older owner published the same value", () => {
    expect(readConvexAuthProviderState()).toBe("unavailable");
    const clearOlder = publishConvexAuthProviderState("ready");
    const clearNewer = publishConvexAuthProviderState("ready");
    clearOlder();
    expect(readConvexAuthProviderState()).toBe("ready");

    const clearLatest = publishConvexAuthProviderState("token_recovery");
    // A repeated or out-of-order cleanup must not erase the latest commit.
    clearNewer();
    clearOlder();
    expect(readConvexAuthProviderState()).toBe("token_recovery");
    clearLatest();
    expect(readConvexAuthProviderState()).toBe("unavailable");
  });
});

describe("Convex auth token decision diagnostics", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports only the committed provider's latest attempt", () => {
    jest.useFakeTimers();
    const owner = createConvexAuthTokenDecisionOwner();
    // An unpublished (discarded) owner's attempts are never read.
    beginConvexAuthTokenDecision(owner, "ordinary", true)("token", true);
    expect(readConvexAuthTokenDecision()).toBeUndefined();

    const clear = publishConvexAuthProviderState("ready", owner);
    try {
      expect(closedDecision()).toEqual({
        mode: "ordinary",
        outcome: "token",
        result: "token",
        age: "lt_1s",
        context: "same",
      });

      const settleOlder = beginConvexAuthTokenDecision(owner, "ordinary", true);
      const settleNewer = beginConvexAuthTokenDecision(
        owner,
        "forced_refresh",
        true,
      );
      expect(closedDecision()).toMatchObject({
        mode: "forced_refresh",
        outcome: "pending",
        result: "pending",
      });
      settleNewer("exception_fallback", false);
      // A stale completion cannot overwrite the newer attempt's evidence, and
      // an attempt settles only once.
      settleOlder("token", true);
      settleNewer("token", true);
      expect(closedDecision()).toMatchObject({
        mode: "forced_refresh",
        outcome: "exception_fallback",
        result: "null",
      });

      // A provider-state re-publish keeps the same owner's evidence.
      const clearRecovery = publishConvexAuthProviderState(
        "token_recovery",
        owner,
      );
      clear();
      expect(closedDecision()).toMatchObject({
        outcome: "exception_fallback",
      });
      clearRecovery();
      expect(readConvexAuthTokenDecision()).toBeUndefined();
    } finally {
      clear();
    }
  });

  it("buckets age from the latest start or settlement", () => {
    jest.useFakeTimers();
    const owner = createConvexAuthTokenDecisionOwner();
    const clear = publishConvexAuthProviderState("ready", owner);
    try {
      const settle = beginConvexAuthTokenDecision(owner, "recovery", true);
      const ages: string[] = [];
      for (const ms of [999, 1, 8_999, 1, 49_999, 1, 539_999, 1]) {
        jest.advanceTimersByTime(ms);
        ages.push(closedDecision().age);
      }
      expect(ages).toEqual([
        "lt_1s",
        "lt_10s",
        "lt_10s",
        "lt_1m",
        "lt_1m",
        "lt_10m",
        "lt_10m",
        "gte_10m",
      ]);
      settle("null");
      expect(closedDecision()).toMatchObject({
        outcome: "null",
        // Recovery returns nothing to Convex.
        result: "no_result",
        age: "lt_1s",
      });
    } finally {
      clear();
    }
  });

  it("distinguishes an auth context switch without retaining the context", () => {
    const owner = createConvexAuthTokenDecisionOwner();
    const clear = publishConvexAuthProviderState("ready", owner);
    try {
      const settle = beginConvexAuthTokenDecision(owner, "ordinary", true);
      expect(closedDecision().context).toBe("same");
      advanceConvexAuthTokenDecisionContext(owner);
      expect(closedDecision().context).toBe("superseded");
      settle("context_superseded", false);
      expect(closedDecision()).toMatchObject({
        outcome: "context_superseded",
        context: "superseded",
      });
    } finally {
      clear();
    }
  });

  it("ignores a callback invoked for an older context after a newer attempt", () => {
    const owner = createConvexAuthTokenDecisionOwner();
    const clear = publishConvexAuthProviderState("ready", owner);
    try {
      advanceConvexAuthTokenDecisionContext(owner);
      beginConvexAuthTokenDecision(
        owner,
        "forced_refresh",
        true,
      )("token", true);
      const before = readConvexAuthTokenDecision()?.attempt;

      const settleStale = beginConvexAuthTokenDecision(
        owner,
        "ordinary",
        false,
      );
      settleStale("context_superseded", false);
      expect(readConvexAuthTokenDecision()?.attempt).toBe(before);
      expect(closedDecision()).toEqual({
        mode: "forced_refresh",
        outcome: "token",
        result: "token",
        age: "lt_1s",
        context: "same",
      });
    } finally {
      clear();
    }
  });

  const VALID = {
    mode: "ordinary",
    outcome: "token",
    result: "token",
    age: "lt_1s",
    context: "same",
  };

  it.each([
    ["missing", undefined],
    ["undefined", () => undefined],
    [
      "throwing",
      () => {
        throw new Error("private-reader-canary");
      },
    ],
    ["string", () => "token"],
    ["near-miss", () => ({ ...VALID, mode: "ORDINARY" })],
    [
      "partial",
      () => ({
        mode: "ordinary",
        outcome: "token",
        age: "lt_1s",
        context: "same",
      }),
    ],
    ["private value", () => ({ ...VALID, outcome: "private-token-canary" })],
    ["private result", () => ({ ...VALID, result: "private-token-canary" })],
    ["boxed", () => ({ ...VALID, mode: new String("ordinary") })],
    ["populated array", () => Object.assign([], VALID)],
    ["inherited", () => Object.create(VALID)],
    ["null prototype", () => Object.assign(Object.create(null), VALID)],
  ])("closes a %s read to unavailable", (_label, read) => {
    expect(readClosedConvexAuthTokenDecision(read)).toEqual({
      mode: "unavailable",
      outcome: "unavailable",
      result: "unavailable",
      age: "unavailable",
      context: "unavailable",
      attempt: null,
    });
  });

  it("never invokes a getter on the read value", () => {
    const getter = jest.fn(() => {
      throw new Error("private-getter-canary");
    });
    const value = Object.defineProperty({ ...VALID }, "mode", {
      enumerable: true,
      get: getter,
    });
    expect(readClosedConvexAuthTokenDecision(() => value).mode).toBe(
      "unavailable",
    );
    const attemptGetter = jest.fn(() => ({}));
    const withAttemptGetter = Object.defineProperty({ ...VALID }, "attempt", {
      enumerable: true,
      get: attemptGetter,
    });
    expect(
      readClosedConvexAuthTokenDecision(() => withAttemptGetter),
    ).toMatchObject({ mode: "ordinary", attempt: null });
    expect(getter).not.toHaveBeenCalled();
    expect(attemptGetter).not.toHaveBeenCalled();
  });

  it("returns an isolated unavailable record for each read", () => {
    const first = readClosedConvexAuthTokenDecision(undefined);
    (first as { mode: string }).mode = "ordinary";
    (first as { attempt: object | null }).attempt = {};
    expect(readClosedConvexAuthTokenDecision(undefined)).toEqual({
      mode: "unavailable",
      outcome: "unavailable",
      result: "unavailable",
      age: "unavailable",
      context: "unavailable",
      attempt: null,
    });
  });

  it("drops extra fields and keeps only closed values", () => {
    const attempt = {};
    const closed = readClosedConvexAuthTokenDecision(() => ({
      mode: "recovery",
      outcome: "cached_fallback",
      result: "no_result",
      age: "lt_10m",
      context: "superseded",
      attempt,
      token: "private-token-canary",
      error: "private-error-canary",
    }));
    expect(closed).toEqual({
      mode: "recovery",
      outcome: "cached_fallback",
      result: "no_result",
      age: "lt_10m",
      context: "superseded",
      attempt,
    });
    expect(JSON.stringify(closed)).not.toContain("canary");
  });
});
