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

    expect(result).toEqual({ userIds: [], orgId: null });
    expect(mockListMemberships).not.toHaveBeenCalled();
  });
});
