import { describe, expect, it } from "@jest/globals";
import { ChatSDKError, isNetworkStreamError } from "../errors";

describe("isNetworkStreamError", () => {
  it("classifies common browser stream transport failures as reconnectable", () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "connection closed",
      "Error in input stream",
    ]) {
      expect(isNetworkStreamError(new Error(message))).toBe(true);
    }
  });

  it("does not classify user aborts as reconnectable", () => {
    expect(
      isNetworkStreamError(new DOMException("Aborted", "AbortError")),
    ).toBe(false);
  });

  it("uses ChatSDKError offline type for SDK errors", () => {
    expect(isNetworkStreamError(new ChatSDKError("offline:stream"))).toBe(true);
    expect(isNetworkStreamError(new ChatSDKError("bad_request:stream"))).toBe(
      false,
    );
  });
});
