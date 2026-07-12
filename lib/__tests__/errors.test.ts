import { describe, expect, it } from "@jest/globals";
import {
  ChatSDKError,
  deserializeChatSDKErrorFromStream,
  isNetworkStreamError,
  serializeChatSDKErrorForStream,
} from "../errors";

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

describe("ChatSDKError messages", () => {
  it("uses a sandbox-specific message for attachment upload failures", () => {
    expect(new ChatSDKError("bad_request:sandbox").message).toBe(
      "The computer attachment upload failed.",
    );
  });
});

describe("ChatSDKError stream serialization", () => {
  it("preserves rate-limit metadata across text-only streams", () => {
    const original = new ChatSDKError(
      "rate_limit:chat",
      "Monthly usage is exhausted.",
      {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: { available: true },
      },
    );

    const parsed = deserializeChatSDKErrorFromStream(
      new Error(serializeChatSDKErrorForStream(original)),
    );

    expect(parsed).toBeInstanceOf(ChatSDKError);
    expect(parsed).toMatchObject({
      type: "rate_limit",
      surface: "chat",
      cause: "Monthly usage is exhausted.",
      metadata: {
        capReason: "monthly_exhausted",
        paidDailyFreeAllowance: { available: true },
      },
    });
  });

  it.each([
    "__HACKERAI_CHAT_SDK_ERROR__:{",
    '__HACKERAI_CHAT_SDK_ERROR__:{"code":"future:surface"}',
  ])("returns a friendly error for malformed payload %s", (payload) => {
    const parsed = deserializeChatSDKErrorFromStream(new Error(payload));

    expect(parsed).toBeInstanceOf(ChatSDKError);
    expect(parsed).toMatchObject({
      type: "bad_request",
      surface: "stream",
      cause:
        "Something went wrong while receiving the response. Please try again.",
    });
    expect(parsed?.cause).not.toContain("__HACKERAI_CHAT_SDK_ERROR__");
  });

  it("ignores ordinary unstructured errors", () => {
    expect(
      deserializeChatSDKErrorFromStream(new Error("ordinary failure")),
    ).toBeNull();
  });
});
