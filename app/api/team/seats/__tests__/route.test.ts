import { PATCH } from "../route";
import { workos } from "../../../workos";
import { stripe } from "../../../stripe";
import { requireAdminOrg } from "../../team-auth";
import {
  acquireTeamSeatOperationLock,
  TeamSeatOperationLockUnavailableError,
} from "@/lib/billing/team-seat-operation-lock";

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("../../team-auth", () => ({
  requireAdminOrg: jest.fn(),
}));

jest.mock("@/lib/billing/team-seat-operation-lock", () => ({
  acquireTeamSeatOperationLock: jest.fn(),
  TeamSeatOperationLockUnavailableError: class extends Error {},
}));

jest.mock("../../../workos", () => ({
  workos: {
    organizations: { getOrganization: jest.fn() },
    userManagement: {
      listOrganizationMemberships: jest.fn(),
      listInvitations: jest.fn(),
    },
  },
}));

jest.mock("../../../stripe", () => ({
  stripe: {
    paymentMethods: { retrieve: jest.fn() },
    subscriptions: { list: jest.fn(), update: jest.fn() },
  },
}));

const mockRequireAdminOrg = requireAdminOrg as jest.MockedFunction<
  typeof requireAdminOrg
>;
const mockAcquireLock = acquireTeamSeatOperationLock as jest.MockedFunction<
  typeof acquireTeamSeatOperationLock
>;
const mockGetOrganization = workos.organizations
  .getOrganization as jest.MockedFunction<
  typeof workos.organizations.getOrganization
>;
const mockListMemberships = workos.userManagement
  .listOrganizationMemberships as jest.MockedFunction<
  typeof workos.userManagement.listOrganizationMemberships
>;
const mockListInvitations = workos.userManagement
  .listInvitations as jest.MockedFunction<
  typeof workos.userManagement.listInvitations
>;
const mockListSubscriptions = stripe.subscriptions.list as jest.MockedFunction<
  typeof stripe.subscriptions.list
>;
const mockUpdateSubscription = stripe.subscriptions
  .update as jest.MockedFunction<typeof stripe.subscriptions.update>;

const request = (quantity: number) =>
  ({ json: async () => ({ quantity }) }) as never;

describe("PATCH /api/team/seats", () => {
  const assertOwned = jest.fn();
  const release = jest.fn();
  const autoPaginateMemberships = jest.fn();
  const autoPaginateInvitations = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminOrg.mockResolvedValue({
      ok: true,
      userId: "user-admin",
      organizationId: "org-123",
      membership: { role: { slug: "admin" } },
    } as never);
    assertOwned.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    mockAcquireLock.mockResolvedValue({ assertOwned, release });
    mockGetOrganization.mockResolvedValue({
      id: "org-123",
      stripeCustomerId: "cus-123",
    } as never);
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub-123",
          default_payment_method: null,
          items: {
            data: [
              {
                id: "si-123",
                quantity: 3,
                price: { id: "price-123" },
              },
            ],
          },
        },
      ],
    } as never);
    autoPaginateMemberships.mockResolvedValue([{}]);
    autoPaginateInvitations.mockResolvedValue([]);
    mockListMemberships.mockResolvedValue({
      autoPagination: autoPaginateMemberships,
    } as never);
    mockListInvitations.mockResolvedValue({
      autoPagination: autoPaginateInvitations,
    } as never);
    mockUpdateSubscription.mockResolvedValue({} as never);
  });

  it("holds the organization lock across the seat count and decrease", async () => {
    const response = await PATCH(request(2));

    expect(response.status).toBe(200);
    expect(mockAcquireLock).toHaveBeenCalledWith("org-123");
    expect(mockAcquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockListMemberships.mock.invocationCallOrder[0],
    );
    expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateSubscription.mock.invocationCallOrder[0],
    );
    expect(mockUpdateSubscription).toHaveBeenCalledWith("sub-123", {
      items: [{ id: "si-123", quantity: 2 }],
      proration_behavior: "create_prorations",
      proration_date: expect.any(Number),
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects contention before reading the seat state", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);

    const response = await PATCH(request(2));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Another team seat operation is being processed",
      message: "Please retry after the current operation finishes.",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("fails closed when seat operation locking is unavailable", async () => {
    mockAcquireLock.mockRejectedValueOnce(
      new TeamSeatOperationLockUnavailableError(),
    );

    const response = await PATCH(request(2));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Team seat service temporarily unavailable",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("fails closed when lock ownership is lost before updating Stripe", async () => {
    assertOwned.mockRejectedValueOnce(
      new TeamSeatOperationLockUnavailableError(),
    );

    const response = await PATCH(request(2));

    expect(response.status).toBe(503);
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses every WorkOS page when validating a decrease", async () => {
    mockListSubscriptions.mockResolvedValueOnce({
      data: [
        {
          id: "sub-123",
          default_payment_method: null,
          items: {
            data: [
              {
                id: "si-123",
                quantity: 5,
                price: { id: "price-123" },
              },
            ],
          },
        },
      ],
    } as never);
    autoPaginateMemberships.mockResolvedValueOnce([{}, {}, {}]);
    autoPaginateInvitations.mockResolvedValueOnce([{ state: "pending" }]);

    const response = await PATCH(request(3));

    expect(response.status).toBe(400);
    expect(autoPaginateMemberships).toHaveBeenCalledTimes(1);
    expect(autoPaginateInvitations).toHaveBeenCalledTimes(1);
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
