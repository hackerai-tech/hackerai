import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockWithAuth = jest.fn();
const mockListOrganizationMemberships = jest.fn();

jest.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: mockWithAuth,
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    baseURL: "https://api.workos.test",
    userManagement: {
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
  },
}));

describe("getBillingActionContext", () => {
  beforeEach(() => {
    jest.resetModules();
    mockWithAuth.mockReset();
    mockListOrganizationMemberships.mockReset();
  });

  it("normalizes ended-session refresh failures as unauthenticated billing context errors", async () => {
    const endedSessionError = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
          rawData: {
            error: "invalid_grant",
            error_description: "Session has already ended.",
          },
        },
      },
    );
    mockWithAuth.mockRejectedValue(endedSessionError as never);

    const { getBillingActionContext } = await import("../billing-context");

    await expect(getBillingActionContext()).rejects.toThrow(
      "User not authenticated",
    );
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });
});
