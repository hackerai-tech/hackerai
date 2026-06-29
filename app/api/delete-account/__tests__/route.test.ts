import { POST } from "../route";
import { getUserIDWithFreshLoginContext } from "@/lib/auth/get-user-id";
import { deleteUserRateLimitKeys } from "@/lib/rate-limit/token-bucket";
import { stripe } from "../../stripe";
import { workos } from "../../workos";

const mockConvexMutation = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDWithFreshLoginContext: jest.fn(),
}));

jest.mock("@/lib/rate-limit/token-bucket", () => ({
  deleteUserRateLimitKeys: jest.fn(),
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({
    mutation: mockConvexMutation,
  })),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    accountIdentities: {
      markDeleted: "accountIdentities.markDeleted",
    },
    userDeletion: {
      deleteAllUserDataByService: "userDeletion.deleteAllUserDataByService",
    },
  },
}));

jest.mock("../../stripe", () => ({
  stripe: {
    subscriptions: {
      list: jest.fn(),
      cancel: jest.fn(),
    },
    customers: {
      del: jest.fn(),
    },
  },
}));

jest.mock("../../workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: jest.fn(),
      deleteOrganizationMembership: jest.fn(),
      deleteUser: jest.fn(),
    },
    organizations: {
      getOrganization: jest.fn(),
      deleteOrganization: jest.fn(),
    },
  },
}));

const mockGetUserIDWithFreshLoginContext =
  getUserIDWithFreshLoginContext as jest.MockedFunction<
    typeof getUserIDWithFreshLoginContext
  >;
const mockDeleteUserRateLimitKeys =
  deleteUserRateLimitKeys as jest.MockedFunction<
    typeof deleteUserRateLimitKeys
  >;
const mockListOrganizationMemberships = workos.userManagement
  .listOrganizationMemberships as jest.MockedFunction<
  typeof workos.userManagement.listOrganizationMemberships
>;
const mockDeleteOrganizationMembership = workos.userManagement
  .deleteOrganizationMembership as jest.MockedFunction<
  typeof workos.userManagement.deleteOrganizationMembership
>;
const mockDeleteUser = workos.userManagement.deleteUser as jest.MockedFunction<
  typeof workos.userManagement.deleteUser
>;
const mockGetOrganization = workos.organizations
  .getOrganization as jest.MockedFunction<
  typeof workos.organizations.getOrganization
>;
const mockDeleteOrganization = workos.organizations
  .deleteOrganization as jest.MockedFunction<
  typeof workos.organizations.deleteOrganization
>;
const mockListSubscriptions = stripe.subscriptions.list as jest.MockedFunction<
  typeof stripe.subscriptions.list
>;
const mockCancelSubscription = stripe.subscriptions
  .cancel as jest.MockedFunction<typeof stripe.subscriptions.cancel>;
const mockDeleteCustomer = stripe.customers.del as jest.MockedFunction<
  typeof stripe.customers.del
>;

const request = () => ({ url: "https://hackerai.test/api/delete-account" });

describe("POST /api/delete-account", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    mockGetUserIDWithFreshLoginContext.mockResolvedValue({
      userId: "user_123",
      freeQuotaSubject: "free_quota:v1:identity_hash",
    });
    mockDeleteUserRateLimitKeys.mockResolvedValue(undefined);
    mockConvexMutation.mockImplementation(async (functionReference) =>
      functionReference === "userDeletion.deleteAllUserDataByService"
        ? { hasMore: false }
        : null,
    );
    mockDeleteOrganizationMembership.mockResolvedValue(undefined as never);
    mockDeleteUser.mockResolvedValue(undefined as never);
    mockDeleteOrganization.mockResolvedValue(undefined as never);
    mockCancelSubscription.mockResolvedValue({} as never);
    mockDeleteCustomer.mockResolvedValue({} as never);
  });

  it("removes only the caller's membership for shared organizations", async () => {
    const callerMembership = {
      id: "membership_user",
      organizationId: "org_team",
      userId: "user_123",
      role: { slug: "member" },
    };

    mockListOrganizationMemberships
      .mockResolvedValueOnce({ data: [callerMembership] } as never)
      .mockResolvedValueOnce({
        data: [
          callerMembership,
          {
            id: "membership_admin",
            organizationId: "org_team",
            userId: "user_admin",
            role: { slug: "admin" },
          },
        ],
      } as never);

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "accountIdentities.markDeleted",
      {
        serviceKey: "service_key",
        identityHash: "free_quota:v1:identity_hash",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
    expect(mockDeleteOrganizationMembership).toHaveBeenCalledWith(
      "membership_user",
    );
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockCancelSubscription).not.toHaveBeenCalled();
    expect(mockDeleteCustomer).not.toHaveBeenCalled();
    expect(mockDeleteOrganization).not.toHaveBeenCalled();
    expect(mockDeleteUser).toHaveBeenCalledWith("user_123");
    expect(mockConvexMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockConvexMutation.mock.invocationCallOrder[1],
    );
    expect(mockConvexMutation.mock.invocationCallOrder[1]).toBeLessThan(
      mockDeleteOrganizationMembership.mock.invocationCallOrder[0],
    );
    expect(mockConvexMutation.mock.invocationCallOrder[1]).toBeLessThan(
      mockDeleteUser.mock.invocationCallOrder[0],
    );
  });

  it("deletes billing and organization resources for a solo admin organization", async () => {
    const callerMembership = {
      id: "membership_user",
      organizationId: "org_solo",
      userId: "user_123",
      role: { slug: "admin" },
    };

    mockListOrganizationMemberships
      .mockResolvedValueOnce({ data: [callerMembership] } as never)
      .mockResolvedValueOnce({ data: [callerMembership] } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_solo",
      stripeCustomerId: "cus_123",
    } as never);
    mockListSubscriptions.mockResolvedValue({
      data: [{ id: "sub_1" }, { id: "sub_2" }],
    } as never);

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "accountIdentities.markDeleted",
      {
        serviceKey: "service_key",
        identityHash: "free_quota:v1:identity_hash",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
    expect(mockListSubscriptions).toHaveBeenCalledWith({
      customer: "cus_123",
      status: "all",
      limit: 100,
    });
    expect(mockCancelSubscription).toHaveBeenCalledWith("sub_1");
    expect(mockCancelSubscription).toHaveBeenCalledWith("sub_2");
    expect(mockDeleteCustomer).toHaveBeenCalledWith("cus_123");
    expect(mockDeleteOrganization).toHaveBeenCalledWith("org_solo");
    expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mockDeleteUser).toHaveBeenCalledWith("user_123");
  });

  it("marks identity and runs Convex cleanup before deleting a WorkOS user with no memberships", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      1,
      "accountIdentities.markDeleted",
      {
        serviceKey: "service_key",
        identityHash: "free_quota:v1:identity_hash",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      2,
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation.mock.invocationCallOrder[1]).toBeLessThan(
      mockDeleteUser.mock.invocationCallOrder[0],
    );
  });

  it("does not delete WorkOS or billing resources if Convex cleanup fails", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);
    mockConvexMutation
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Convex cleanup failed"));

    const response = await POST(request() as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Convex cleanup failed");
    expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockDeleteCustomer).not.toHaveBeenCalled();
    expect(mockDeleteOrganization).not.toHaveBeenCalled();
    expect(mockDeleteUserRateLimitKeys).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("repeats Convex cleanup batches before deleting external identity resources", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);
    mockConvexMutation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hasMore: true })
      .mockResolvedValueOnce({ hasMore: false });

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      1,
      "accountIdentities.markDeleted",
      {
        serviceKey: "service_key",
        identityHash: "free_quota:v1:identity_hash",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      2,
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenNthCalledWith(
      3,
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation.mock.invocationCallOrder[2]).toBeLessThan(
      mockDeleteUser.mock.invocationCallOrder[0],
    );
    expect(mockDeleteUser).toHaveBeenCalledWith("user_123");
  });

  it("does not delete external identity resources when Convex cleanup returns an unexpected shape", async () => {
    mockListOrganizationMemberships.mockResolvedValueOnce({
      data: [],
    } as never);
    mockConvexMutation.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const response = await POST(request() as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("unexpected response");
    expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockDeleteCustomer).not.toHaveBeenCalled();
    expect(mockDeleteOrganization).not.toHaveBeenCalled();
    expect(mockDeleteUserRateLimitKeys).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("does not delete org billing when a shared-org admin deletes their account", async () => {
    const callerMembership = {
      id: "membership_admin",
      organizationId: "org_team",
      userId: "user_123",
      role: { slug: "admin" },
    };

    mockListOrganizationMemberships
      .mockResolvedValueOnce({ data: [callerMembership] } as never)
      .mockResolvedValueOnce({
        data: [
          callerMembership,
          {
            id: "membership_other_admin",
            organizationId: "org_team",
            userId: "user_admin",
            role: { slug: "admin" },
          },
          {
            id: "membership_member",
            organizationId: "org_team",
            userId: "user_member",
            role: { slug: "member" },
          },
        ],
      } as never);

    const response = await POST(request() as any);

    expect(response.status).toBe(200);
    expect(mockDeleteOrganizationMembership).toHaveBeenCalledWith(
      "membership_admin",
    );
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockDeleteCustomer).not.toHaveBeenCalled();
    expect(mockDeleteOrganization).not.toHaveBeenCalled();
    expect(mockDeleteUser).toHaveBeenCalledWith("user_123");
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "accountIdentities.markDeleted",
      {
        serviceKey: "service_key",
        identityHash: "free_quota:v1:identity_hash",
        userId: "user_123",
      },
    );
    expect(mockConvexMutation).toHaveBeenCalledWith(
      "userDeletion.deleteAllUserDataByService",
      {
        serviceKey: "service_key",
        userId: "user_123",
      },
    );
  });

  it("blocks deletion when the caller is the last admin of a shared organization", async () => {
    const callerMembership = {
      id: "membership_admin",
      organizationId: "org_team",
      userId: "user_123",
      role: { slug: "admin" },
    };

    mockListOrganizationMemberships
      .mockResolvedValueOnce({ data: [callerMembership] } as never)
      .mockResolvedValueOnce({
        data: [
          callerMembership,
          {
            id: "membership_member",
            organizationId: "org_team",
            userId: "user_member",
            role: { slug: "member" },
          },
        ],
      } as never);

    const response = await POST(request() as any);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("last admin");
    expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
    expect(mockDeleteOrganization).not.toHaveBeenCalled();
    expect(mockConvexMutation).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});
