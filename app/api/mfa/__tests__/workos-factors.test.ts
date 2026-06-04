import { workos } from "@/app/api/workos";
import { listUserMfaFactors } from "../workos-factors";

jest.mock("@/app/api/workos", () => ({
  workos: {
    get: jest.fn(),
  },
}));

const mockWorkosGet = workos.get as jest.Mock;

describe("listUserMfaFactors", () => {
  it("maps auth factors without requiring TOTP data", async () => {
    mockWorkosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: "auth_factor_totp",
            type: "totp",
            created_at: "2026-06-04T15:00:00.000Z",
            updated_at: "2026-06-04T15:01:00.000Z",
            totp: {
              issuer: "HackerAI",
              user: "user@example.com",
            },
          },
          {
            id: "auth_factor_without_totp",
            type: "sms",
            created_at: "2026-06-04T15:02:00.000Z",
            updated_at: "2026-06-04T15:03:00.000Z",
          },
        ],
      },
    });

    await expect(listUserMfaFactors("user_123")).resolves.toEqual([
      {
        id: "auth_factor_totp",
        type: "totp",
        issuer: "HackerAI",
        user: "user@example.com",
        createdAt: "2026-06-04T15:00:00.000Z",
        updatedAt: "2026-06-04T15:01:00.000Z",
      },
      {
        id: "auth_factor_without_totp",
        type: "sms",
        issuer: undefined,
        user: undefined,
        createdAt: "2026-06-04T15:02:00.000Z",
        updatedAt: "2026-06-04T15:03:00.000Z",
      },
    ]);

    expect(mockWorkosGet).toHaveBeenCalledWith(
      "/user_management/users/user_123/auth_factors",
      { query: { order: "desc" } },
    );
  });
});
