import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRequireTeamOrg = jest.fn();
const mockGetOrganizationMembership = jest.fn();
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

  it("falls back to invitation revocation only when membership is not found", async () => {
    mockGetOrganizationMembership.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { status: 404 }) as never,
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
  });
});
