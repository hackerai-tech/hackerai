import { describe, expect, it, jest } from "@jest/globals";

import { resolveClientInitialAuth } from "../initial-auth";

describe("resolveClientInitialAuth", () => {
  it("preserves the ordinary signed-out state", async () => {
    await expect(
      resolveClientInitialAuth(
        jest.fn<any>().mockResolvedValue({ user: null }),
      ),
    ).resolves.toEqual({ user: null });
  });

  it("hydrates an ended refresh session as signed out", async () => {
    const error = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
        },
      },
    );

    await expect(
      resolveClientInitialAuth(
        jest.fn<() => Promise<never>>().mockRejectedValue(error),
      ),
    ).resolves.toEqual({ user: null });
  });

  it("removes the server-only access token from authenticated state", async () => {
    await expect(
      resolveClientInitialAuth(
        jest.fn<any>().mockResolvedValue({
          user: { id: "user-1" },
          sessionId: "session-1",
          accessToken: "server-secret",
        }),
      ),
    ).resolves.toEqual({
      user: { id: "user-1" },
      sessionId: "session-1",
    });
  });

  it("keeps unrelated authentication failures visible", async () => {
    const error = new Error("JWKS request timed out");

    await expect(
      resolveClientInitialAuth(
        jest.fn<() => Promise<never>>().mockRejectedValue(error),
      ),
    ).rejects.toBe(error);
  });

  it("does not treat other invalid_grant failures as ended sessions", async () => {
    const error = Object.assign(new Error("Error: invalid_grant"), {
      error: "invalid_grant",
      errorDescription: "Invalid code verifier.",
    });

    await expect(
      resolveClientInitialAuth(
        jest.fn<() => Promise<never>>().mockRejectedValue(error),
      ),
    ).rejects.toBe(error);
  });
});
