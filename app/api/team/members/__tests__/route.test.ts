import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";

const mockRequireTeamOrg = jest.fn();
const mockGetOrganization = jest.fn();
const mockGetOrganizationMembership = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockListInvitations = jest.fn();
const mockGetUser = jest.fn();
const mockDeleteOrganizationMembership = jest.fn();
const mockGetInvitation = jest.fn();
const mockRevokeInvitation = jest.fn();
const mockListSubscriptions = jest.fn();
const mockRetrievePrice = jest.fn();

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

const membership = (userId: string, role: "admin" | "member") => ({
  id: `membership_${userId}`,
  organizationId: "org_team",
  userId,
  role: { slug: role },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const invitation = (id: string, state: string) => ({
  id,
  email: `${id}@example.com`,
  state,
  createdAt: "2026-01-02T00:00:00.000Z",
  expiresAt: "2026-02-02T00:00:00.000Z",
});

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("../../team-auth", () => ({
  requireTeamOrg: mockRequireTeamOrg,
}));

jest.mock("../../../workos", () => ({
  workos: {
    organizations: { getOrganization: mockGetOrganization },
    userManagement: {
      getOrganizationMembership: mockGetOrganizationMembership,
      listOrganizationMemberships: mockListOrganizationMemberships,
      listInvitations: mockListInvitations,
      getUser: mockGetUser,
      deleteOrganizationMembership: mockDeleteOrganizationMembership,
      getInvitation: mockGetInvitation,
      revokeInvitation: mockRevokeInvitation,
    },
  },
}));

jest.mock("../../../stripe", () => ({
  stripe: {
    subscriptions: { list: mockListSubscriptions },
    prices: { retrieve: mockRetrievePrice },
  },
}));

jest.mock("@/lib/rate-limit", () => ({
  getTeamMemberConsumed: jest.fn(),
  addOrgRemovedUsage: jest.fn(),
}));

function makeRequest(id = "membership_or_invitation_id") {
  return { url: `https://hackerai.example/api/team/members?id=${id}` } as any;
}

describe("GET /api/team/members", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireTeamOrg.mockResolvedValue({
      ok: true,
      userId: "user_admin",
      organizationId: "org_team",
      membership: { role: { slug: "admin" } },
    } as never);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      name: "Team",
      stripeCustomerId: "cus_team",
    } as never);
    mockGetUser.mockImplementation((async (userId: string) => ({
      email: `${userId}@example.com`,
      firstName: "",
      lastName: "",
    })) as never);
    mockListSubscriptions.mockResolvedValue({
      data: [{ items: { data: [{ quantity: 8, price: { id: "price" } }] } }],
    } as never);
    mockRetrievePrice.mockResolvedValue({
      recurring: { interval: "month" },
    } as never);
  });

  it("returns the full roster and pending invitations from every page", async () => {
    mockListOrganizationMemberships.mockImplementation(
      workosList([
        [membership("user_admin", "admin"), membership("user_a", "member")],
        [membership("user_b", "member")],
      ]) as never,
    );
    mockListInvitations.mockImplementation(
      workosList([
        [
          invitation("inv_1", "pending"),
          invitation("inv_accepted", "accepted"),
        ],
        [invitation("inv_2", "pending"), invitation("inv_revoked", "revoked")],
      ]) as never,
    );

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      organizationId: "org_team",
      statuses: ["active"],
    });
    expect(body.members.map((m: { email: string }) => m.email)).toEqual([
      "user_admin@example.com",
      "user_a@example.com",
      "user_b@example.com",
    ]);
    expect(body.invitations.map((i: { id: string }) => i.id)).toEqual([
      "inv_1",
      "inv_2",
    ]);
    expect(body.teamInfo).toEqual({
      teamId: "org_team",
      teamName: "Team",
      currentSeats: 3,
      totalSeats: 8,
      availableSeats: 3,
      billingPeriod: "monthly",
    });
  });

  it("fails instead of returning a partial roster when a later page fails", async () => {
    mockListOrganizationMemberships.mockImplementation(
      workosList(
        [[membership("user_admin", "admin")], [membership("user_a", "member")]],
        { page: 1, error: new Error("WorkOS page unavailable") },
      ) as never,
    );
    mockListInvitations.mockImplementation(workosList([[]]) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { GET } = await import("../route");
      const response = await GET(makeRequest());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "WorkOS page unavailable",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("DELETE /api/team/members", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireTeamOrg.mockResolvedValue({
      ok: true,
      userId: "user_admin",
      organizationId: "org_team",
      membership: { role: { slug: "admin" } },
    } as never);
  });

  it("does not treat a transient membership lookup failure as an invitation", async () => {
    mockGetOrganizationMembership.mockRejectedValueOnce(
      Object.assign(new Error("WorkOS unavailable"), {
        statusCode: 503,
      }) as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({ error: "WorkOS unavailable" });
      expect(mockGetInvitation).not.toHaveBeenCalled();
      expect(mockRevokeInvitation).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([{ status: 404 }, { statusCode: 404 }])(
    "falls back to invitation revocation when membership lookup returns %o",
    async (notFoundShape) => {
      mockGetOrganizationMembership.mockRejectedValueOnce(
        Object.assign(new Error("Not found"), notFoundShape) as never,
      );
      mockGetInvitation.mockResolvedValueOnce({
        id: "invitation_id",
        organizationId: "org_team",
      } as never);

      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("invitation_id"));

      expect(response.status).toBe(200);
      expect(mockGetInvitation).toHaveBeenCalledWith("invitation_id");
      expect(mockRevokeInvitation).toHaveBeenCalledWith("invitation_id");
      expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    },
  );

  it("does not treat a transient invitation lookup failure as not found", async () => {
    mockGetOrganizationMembership.mockRejectedValueOnce(
      Object.assign(new Error("Membership not found"), {
        status: 404,
      }) as never,
    );
    mockGetInvitation.mockRejectedValueOnce(
      Object.assign(new Error("WorkOS unavailable"), {
        statusCode: 503,
      }) as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("invitation_id"));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "WorkOS unavailable" });
      expect(mockRevokeInvitation).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not treat a failed invitation revocation as not found", async () => {
    mockGetOrganizationMembership.mockRejectedValueOnce(
      Object.assign(new Error("Membership not found"), {
        status: 404,
      }) as never,
    );
    mockGetInvitation.mockResolvedValueOnce({
      id: "invitation_id",
      organizationId: "org_team",
    } as never);
    mockRevokeInvitation.mockRejectedValueOnce(
      Object.assign(new Error("Revocation failed"), { status: 404 }) as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("invitation_id"));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Revocation failed" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not allow a non-admin to revoke an invitation", async () => {
    mockRequireTeamOrg.mockResolvedValueOnce({
      ok: true,
      userId: "user_member",
      organizationId: "org_team",
      membership: { role: { slug: "member" } },
    } as never);
    mockGetOrganizationMembership.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }) as never,
    );

    const { DELETE } = await import("../route");
    const response = await DELETE(makeRequest("invitation_id"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only admins can revoke invitations",
    });
    expect(mockGetInvitation).not.toHaveBeenCalled();
    expect(mockRevokeInvitation).not.toHaveBeenCalled();
  });

  it("does not treat a later membership API 404 as an invitation", async () => {
    mockGetOrganizationMembership.mockResolvedValueOnce({
      id: "membership_id",
      organizationId: "org_team",
      userId: "user_member",
      role: { slug: "member" },
    } as never);
    mockListOrganizationMemberships.mockRejectedValueOnce(
      Object.assign(new Error("Membership list unavailable"), {
        statusCode: 404,
      }) as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("membership_id"));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Membership list unavailable",
      });
      expect(mockGetInvitation).not.toHaveBeenCalled();
      expect(mockRevokeInvitation).not.toHaveBeenCalled();
      expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe("last-admin protection", () => {
    beforeEach(() => {
      mockGetOrganizationMembership.mockResolvedValue(
        membership("user_admin", "admin") as never,
      );
    });

    it("lets an admin leave when another admin is on a later page", async () => {
      mockListOrganizationMemberships.mockImplementation(
        workosList([
          [membership("user_admin", "admin"), membership("user_a", "member")],
          [membership("user_admin_2", "admin")],
        ]) as never,
      );

      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("membership_user_admin"));

      expect(response.status).toBe(200);
      expect(mockDeleteOrganizationMembership).toHaveBeenCalledWith(
        "membership_user_admin",
      );
    });

    it("keeps the last admin when no later page has another admin", async () => {
      mockListOrganizationMemberships.mockImplementation(
        workosList([
          [membership("user_admin", "admin"), membership("user_a", "member")],
          [membership("user_b", "member")],
        ]) as never,
      );

      const { DELETE } = await import("../route");
      const response = await DELETE(makeRequest("membership_user_admin"));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "Cannot leave as the last admin",
      });
      expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
    });

    it("does not remove a member when a later membership page fails", async () => {
      mockGetOrganizationMembership.mockResolvedValueOnce(
        membership("user_a", "member") as never,
      );
      mockListOrganizationMemberships.mockImplementation(
        workosList(
          [
            [membership("user_admin", "admin")],
            [membership("user_a", "member")],
          ],
          { page: 1, error: new Error("WorkOS page unavailable") },
        ) as never,
      );
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        const { DELETE } = await import("../route");
        const response = await DELETE(makeRequest("membership_user_a"));

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "WorkOS page unavailable",
        });
        expect(mockDeleteOrganizationMembership).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
