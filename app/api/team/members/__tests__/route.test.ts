import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRequireTeamOrg = jest.fn();
const mockGetOrganizationMembership = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockDeleteOrganizationMembership = jest.fn();
const mockGetInvitation = jest.fn();
const mockRevokeInvitation = jest.fn();

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
    userManagement: {
      getOrganizationMembership: mockGetOrganizationMembership,
      listOrganizationMemberships: mockListOrganizationMemberships,
      deleteOrganizationMembership: mockDeleteOrganizationMembership,
      getInvitation: mockGetInvitation,
      revokeInvitation: mockRevokeInvitation,
    },
  },
}));

jest.mock("@/lib/rate-limit", () => ({
  getTeamMemberConsumed: jest.fn(),
  addOrgRemovedUsage: jest.fn(),
}));

function makeRequest(id = "membership_or_invitation_id") {
  return { url: `https://hackerai.example/api/team/members?id=${id}` } as any;
}

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
});
