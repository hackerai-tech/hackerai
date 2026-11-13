import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserID = jest.fn();
const mockListSessions = jest.fn();
const mockRevokeSession = jest.fn();

jest.mock("@/lib/auth/get-user-id", () => ({ getUserID: mockGetUserID }));
jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      listSessions: mockListSessions,
      revokeSession: mockRevokeSession,
    },
  },
}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

function request(origin: string | null) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return {
    url: "https://hackerai.example/api/logout-all",
    headers,
  } as never;
}

describe("POST /api/logout-all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserID.mockResolvedValue("user_test" as never);
    mockListSessions.mockResolvedValue({
      data: [{ id: "session_test" }],
    } as never);
  });

  it.each(["https://evil.hackerai.example", "https://other.example", null])(
    "rejects origin %s before looking up the user",
    async (origin) => {
      const { POST } = await import("../route");
      expect((await POST(request(origin))).status).toBe(403);
      expect(mockGetUserID).not.toHaveBeenCalled();
      expect(mockRevokeSession).not.toHaveBeenCalled();
    },
  );

  it("still revokes sessions for a same-origin request", async () => {
    const { POST } = await import("../route");
    expect((await POST(request("https://hackerai.example"))).status).toBe(200);
    expect(mockRevokeSession).toHaveBeenCalledWith({
      sessionId: "session_test",
    });
  });
});
