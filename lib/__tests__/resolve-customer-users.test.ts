import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

const mockRetrieveCustomer = jest.fn();
const mockListMemberships = jest.fn();

jest.mock("@/app/api/stripe", () => ({
  stripe: {
    customers: {
      retrieve: mockRetrieveCustomer,
    },
  },
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListMemberships,
    },
  },
}));

describe("resolveUserIdsFromCustomer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses WorkOS autoPagination so all active org members are returned", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({
      deleted: false,
      metadata: { workOSOrganizationId: "org_123" },
    } as never);
    mockListMemberships.mockResolvedValueOnce({
      data: [{ userId: "user_first_page" }],
      autoPagination: jest
        .fn()
        .mockResolvedValue([
          { userId: "user_first_page" },
          { userId: "user_second_page" },
        ]),
    } as never);

    const { resolveUserIdsFromCustomer } =
      await import("../billing/resolve-customer-users");

    const result = await resolveUserIdsFromCustomer("cus_123", "Test Webhook");

    expect(mockListMemberships).toHaveBeenCalledWith({
      organizationId: "org_123",
      statuses: ["active"],
    });
    expect(result).toEqual({
      userIds: ["user_first_page", "user_second_page"],
      orgId: "org_123",
    });
  });

  it("returns no users when the customer has no WorkOS organization metadata", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({
      deleted: false,
      metadata: {},
    } as never);

    const { resolveUserIdsFromCustomer } =
      await import("../billing/resolve-customer-users");

    const result = await resolveUserIdsFromCustomer("cus_123", "Test Webhook");

    expect(result).toEqual({
      userIds: [],
      orgId: null,
      reason: "missing_workos_organization_metadata",
    });
    expect(mockListMemberships).not.toHaveBeenCalled();
  });

  it("classifies legacy user metadata separately from broken WorkOS metadata", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({
      deleted: false,
      metadata: { userId: "b8c832c4-3e1e-4a76-89c1-28a5b4f56302" },
    } as never);

    const { resolveUserIdsFromCustomer } =
      await import("../billing/resolve-customer-users");

    const result = await resolveUserIdsFromCustomer(
      "cus_legacy",
      "Test Webhook",
    );

    expect(result).toEqual({
      userIds: [],
      orgId: null,
      reason: "legacy_user_metadata",
      legacyUserId: "b8c832c4-3e1e-4a76-89c1-28a5b4f56302",
    });
    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[Test Webhook] Customer cus_legacy has legacy user metadata but no workOSOrganizationId metadata",
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns a deleted-customer reason without querying WorkOS memberships", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({
      deleted: true,
      id: "cus_deleted",
    } as never);

    const { resolveUserIdsFromCustomer } =
      await import("../billing/resolve-customer-users");

    const result = await resolveUserIdsFromCustomer(
      "cus_deleted",
      "Test Webhook",
    );

    expect(result).toEqual({
      userIds: [],
      orgId: null,
      reason: "customer_deleted",
    });
    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns a no-active-memberships reason when the org has no active users", async () => {
    mockRetrieveCustomer.mockResolvedValueOnce({
      deleted: false,
      metadata: { workOSOrganizationId: "org_empty" },
    } as never);
    mockListMemberships.mockResolvedValueOnce({
      data: [],
      autoPagination: jest.fn().mockResolvedValue([]),
    } as never);

    const { resolveUserIdsFromCustomer } =
      await import("../billing/resolve-customer-users");

    const result = await resolveUserIdsFromCustomer(
      "cus_empty",
      "Test Webhook",
    );

    expect(result).toEqual({
      userIds: [],
      orgId: "org_empty",
      reason: "no_active_memberships",
    });
  });
});
