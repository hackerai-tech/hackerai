import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("server-only", () => ({}));

import {
  createIntercomMessengerIdentity,
  getIntercomIdentityClaims,
  INTERCOM_JWT_TTL_SECONDS,
} from "../messenger";

describe("Intercom Messenger identity", () => {
  const originalSecret = process.env.INTERCOM_MESSENGER_SECRET;
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalSecret === undefined) {
      delete process.env.INTERCOM_MESSENGER_SECRET;
    } else {
      process.env.INTERCOM_MESSENGER_SECRET = originalSecret;
    }
  });

  it("does not create a production Messenger identity for Preview QA users", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.INTERCOM_MESSENGER_SECRET = "test-preview-secret";
    await expect(
      createIntercomMessengerIdentity({ id: "preview-user" }),
    ).resolves.toBeNull();
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
