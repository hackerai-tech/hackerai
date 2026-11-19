import path from "node:path";
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

// Jest maps @workos-inc/node to an app mock; use the installed SDK paginator so
// fixtures follow its real page traversal (and its `limit` short-circuit).
const { AutoPaginatable } = jest.requireActual(
  path.join(process.cwd(), "node_modules/@workos-inc/node/lib/index.cjs"),
) as typeof import("@workos-inc/node");

/** Serve WorkOS list pages; `failure` rejects the fetch of that page index. */
function workosList<T>(pages: T[][], failure?: { page: number; error: Error }) {
  const fetchPage = async ({ after }: { after?: string | null }) => {
    const page = after ? Number(after) : 0;
    if (failure?.page === page) throw failure.error;
    return {
      object: "list" as const,
      data: pages[page],
      listMetadata: {
        after: page + 1 < pages.length ? String(page + 1) : null,
      },
    };
  };
  return async (options?: object) =>
    new AutoPaginatable(await fetchPage({}), fetchPage, options);
}

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

const member = (id: string) => ({ id, userId: `user_${id}` });
const invitation = (id: string, state: string) => ({ id, state });

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
    mockListMemberships.mockImplementation(
      workosList([[member("m1")]]) as never,
    );
    mockListInvitations.mockImplementation(workosList([[]]) as never);
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
    mockListMemberships.mockImplementation(
      workosList([[member("m1"), member("m2")]]) as never,
    );

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mockSendInvitation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      reachedBy: "members on a later page",
      members: [[member("m1")], [member("m2"), member("m3")]],
      invitations: [[invitation("i1", "pending")]],
      details:
        "You have 3 members and 1 pending invitations (4 total) with 4 seats. Please upgrade to add more members.",
    },
    {
      reachedBy: "pending invitations on a later page",
      members: [[member("m1"), member("m2")]],
      invitations: [
        [invitation("i1", "pending"), invitation("i_accepted", "accepted")],
        [invitation("i2", "pending"), invitation("i_expired", "expired")],
      ],
      details:
        "You have 2 members and 2 pending invitations (4 total) with 4 seats. Please upgrade to add more members.",
    },
  ])(
    "rejects an invitation when capacity is reached by $reachedBy",
    async ({ members, invitations, details }) => {
      mockListSubscriptions.mockResolvedValue({
        data: [{ items: { data: [{ quantity: 4 }] } }],
      } as never);
      mockListMemberships.mockImplementation(workosList(members) as never);
      mockListInvitations.mockImplementation(workosList(invitations) as never);

      const response = await POST(request());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Seat limit reached",
        details,
      });
      expect(mockSendInvitation).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("does not count non-pending invitations on later pages toward seats", async () => {
    mockListSubscriptions.mockResolvedValue({
      data: [{ items: { data: [{ quantity: 4 }] } }],
    } as never);
    mockListMemberships.mockImplementation(
      workosList([[member("m1")], [member("m2")]]) as never,
    );
    mockListInvitations.mockImplementation(
      workosList([
        [invitation("i1", "pending")],
        [
          invitation("i_accepted", "accepted"),
          invitation("i_revoked", "revoked"),
          invitation("i_expired", "expired"),
        ],
      ]) as never,
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockSendInvitation).toHaveBeenCalledTimes(1);
  });

  it("does not send an invitation when a later seat-count page fails", async () => {
    mockListInvitations.mockImplementation(
      workosList([[], [invitation("i1", "pending")]], {
        page: 1,
        error: new Error("WorkOS page unavailable"),
      }) as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(request());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "WorkOS page unavailable",
      });
      expect(mockSendInvitation).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
