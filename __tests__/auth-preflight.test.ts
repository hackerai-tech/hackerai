import {
  assertAuthenticatedSession,
  E2EAuthConfigurationError,
  getLocalAuthCallbackMismatch,
} from "../e2e/helpers/auth-preflight";
import type { Page } from "@playwright/test";

describe("getLocalAuthCallbackMismatch", () => {
  it("returns null when the local app and callback origins match", () => {
    const authorizationUrl =
      "https://api.workos.com/user_management/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fcallback";

    expect(
      getLocalAuthCallbackMismatch(
        "http://localhost:3001/login",
        authorizationUrl,
      ),
    ).toBeNull();
  });

  it("reports a local callback port mismatch", () => {
    const authorizationUrl =
      "https://api.workos.com/user_management/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback";

    expect(
      getLocalAuthCallbackMismatch(
        "http://localhost:3001/login",
        authorizationUrl,
      ),
    ).toEqual({
      appOrigin: "http://localhost:3001",
      redirectUri: "http://localhost:3000/callback",
      redirectOrigin: "http://localhost:3000",
    });
  });

  it("does not impose local callback rules on remote test targets", () => {
    const authorizationUrl =
      "https://api.workos.com/user_management/authorize?redirect_uri=https%3A%2F%2Fauth.hackerai.co%2Fcallback";

    expect(
      getLocalAuthCallbackMismatch(
        "https://preview.hackerai.co/login",
        authorizationUrl,
      ),
    ).toBeNull();
  });

  it("ignores malformed authorization responses", () => {
    expect(
      getLocalAuthCallbackMismatch("http://localhost:3001/login", "not a url"),
    ).toBeNull();
  });
});

describe("assertAuthenticatedSession", () => {
  function createPage(isVisible: boolean): Page {
    const locator = {
      or: jest.fn().mockReturnThis(),
      isVisible: jest.fn().mockResolvedValue(isVisible),
    };

    return {
      getByTestId: jest.fn().mockReturnValue(locator),
    } as unknown as Page;
  }

  it("accepts a visible authenticated shell", async () => {
    await expect(assertAuthenticatedSession(createPage(true))).resolves.toBe(
      undefined,
    );
  });

  it("fails before live actions when storage state is stale", async () => {
    await expect(assertAuthenticatedSession(createPage(false))).rejects.toThrow(
      E2EAuthConfigurationError,
    );
  });
});
