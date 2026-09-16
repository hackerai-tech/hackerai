import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("server-only", () => ({}));

import {
  createIntercomMessengerIdentity,
  getIntercomIdentityClaims,
  INTERCOM_JWT_TTL_SECONDS,
} from "../messenger";

describe("Intercom Messenger identity", () => {
  const originalSecret = process.env.INTERCOM_MESSENGER_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.INTERCOM_MESSENGER_SECRET;
    } else {
      process.env.INTERCOM_MESSENGER_SECRET = originalSecret;
    }
  });

  it("returns null without exposing an unsigned identity when the secret is absent", async () => {
    delete process.env.INTERCOM_MESSENGER_SECRET;

    await expect(
      createIntercomMessengerIdentity({ id: "user_123" }),
    ).resolves.toBeNull();
  });

  it("uses the stable user ID and signed identifying attributes", () => {
    expect(
      getIntercomIdentityClaims({
        id: "user_123",
        email: "person@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).toEqual({
      user_id: "user_123",
      email: "person@example.com",
      name: "Ada Lovelace",
    });
    expect(INTERCOM_JWT_TTL_SECONDS).toBe(300);
  });

  it("omits empty optional attributes from the signed claims", () => {
    expect(
      getIntercomIdentityClaims({
        id: "user_456",
        email: null,
        firstName: null,
        lastName: null,
      }),
    ).toEqual({ user_id: "user_456" });
  });
});
