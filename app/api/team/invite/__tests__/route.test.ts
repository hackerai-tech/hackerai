import { POST } from "../route";
import { workos } from "../../../workos";
import { stripe } from "../../../stripe";
import { requireAdminOrg } from "../../team-auth";
import {
  acquireTeamInvitationLock,
  TeamInvitationLockUnavailableError,
} from "@/lib/billing/team-invitation-lock";

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

jest.mock("@/lib/billing/team-invitation-lock", () => ({
  acquireTeamInvitationLock: jest.fn(),
  TeamInvitationLockUnavailableError: class extends Error {},
}));

jest.mock("../../../workos", () => ({
  workos: {
    organizations: { getOrganization: jest.fn() },
    userManagement: {
      listOrganizationMemberships: jest.fn(),
      listInvitations: jest.fn(),
      listUsers: jest.fn(),
      sendInvitation: jest.fn(),
    },
  },
}));

jest.mock("../../../stripe", () => ({
  stripe: { subscriptions: { list: jest.fn() } },
}));

const mockRequireAdminOrg = requireAdminOrg as jest.MockedFunction<
  typeof requireAdminOrg
>;
const mockAcquireLock = acquireTeamInvitationLock as jest.MockedFunction<
  typeof acquireTeamInvitationLock
>;
const mockGetOrganization = workos.organizations
  .getOrganization as jest.MockedFunction<
  typeof workos.organizations.getOrganization
>;
const mockListSubscriptions = stripe.subscriptions.list as jest.MockedFunction<
  typeof stripe.subscriptions.list
>;
const mockListMemberships = workos.userManagement
  .listOrganizationMemberships as jest.MockedFunction<
  typeof workos.userManagement.listOrganizationMemberships
>;
const mockListInvitations = workos.userManagement
  .listInvitations as jest.MockedFunction<
  typeof workos.userManagement.listInvitations
>;
const mockListUsers = workos.userManagement.listUsers as jest.MockedFunction<
  typeof workos.userManagement.listUsers
>;
const mockSendInvitation = workos.userManagement
  .sendInvitation as jest.MockedFunction<
  typeof workos.userManagement.sendInvitation
>;

const request = (email = "invitee@example.com") =>
  ({ json: async () => ({ email }) }) as never;

describe("POST /api/team/invite", () => {
  const assertOwned = jest.fn();
  const release = jest.fn();

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
      data: [{ items: { data: [{ quantity: 2 }] } }],
    } as never);
    mockListMemberships.mockResolvedValue({ data: [{}] } as never);
    mockListInvitations.mockResolvedValue({ data: [] } as never);
    mockListUsers.mockResolvedValue({ data: [] } as never);
    mockSendInvitation.mockResolvedValue({} as never);
  });

  it("holds the organization lock across the seat check and invitation", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockAcquireLock).toHaveBeenCalledWith("org-123");
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(mockSendInvitation).toHaveBeenCalledWith({
      email: "invitee@example.com",
      organizationId: "org-123",
      inviterUserId: "user-admin",
      roleSlug: "member",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendInvitation.mock.invocationCallOrder[0],
    );
  });

  it("rejects a concurrent invitation before reading seat state", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Another invitation is being processed",
      message: "Please retry after the current invitation finishes.",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it("fails closed when invitation locking is unavailable", async () => {
    mockAcquireLock.mockRejectedValueOnce(
      new TeamInvitationLockUnavailableError(),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Team invitation service temporarily unavailable",
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it("releases the lock when the seat limit rejects the invitation", async () => {
    mockListMemberships.mockResolvedValueOnce({ data: [{}, {}] } as never);

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mockSendInvitation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
