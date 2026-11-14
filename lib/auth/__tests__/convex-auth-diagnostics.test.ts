import { describe, expect, it } from "@jest/globals";
import {
  deriveConvexAuthProviderState,
  publishConvexAuthProviderState,
  readConvexAuthProviderState,
} from "../convex-auth-diagnostics";

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
