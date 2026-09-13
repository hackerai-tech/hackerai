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

  it("changes when first-touch attribution is added", () => {
    expect(
      createPostHogIdentitySignature({
        ...identity,
        firstTouchAttribution: {
          version: 1,
          source: "google",
          medium: "organic",
          referringDomain: "google.com",
          entrySurface: "home",
          capturedAt: "2026-08-14T12:00:00.000Z",
        },
      }),
    ).not.toBe(createPostHogIdentitySignature(identity));
  });
});
