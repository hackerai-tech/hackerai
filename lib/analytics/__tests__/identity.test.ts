import { describe, expect, it } from "@jest/globals";
import { createPostHogIdentitySignature } from "../identity";

describe("createPostHogIdentitySignature", () => {
  const identity = {
    userId: "user_123",
    email: "user@example.com",
    name: "Test User",
    subscription: "pro",
  };

  it("is stable for unchanged analytics identity properties", () => {
    expect(createPostHogIdentitySignature(identity)).toBe(
      createPostHogIdentitySignature(identity),
    );
  });

  it("changes when a person property changes", () => {
    expect(
      createPostHogIdentitySignature({
        ...identity,
        subscription: "ultra",
      }),
    ).not.toBe(createPostHogIdentitySignature(identity));
  });
});
