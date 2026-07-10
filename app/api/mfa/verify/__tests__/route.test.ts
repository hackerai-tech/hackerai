import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserID = jest.fn();
const mockVerifyChallenge = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    multiFactorAuth: {
      verifyChallenge: mockVerifyChallenge,
    },
  },
}));

function makeRequest() {
  return {
    json: jest.fn().mockResolvedValue({
      challengeId: "challenge-1",
      code: "123456",
    }),
  } as any;
}

describe("POST /api/mfa/verify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserID.mockResolvedValue("user-1" as never);
  });

  it("returns a client error without error logging after too many attempts", async () => {
    mockVerifyChallenge.mockRejectedValue(
      new Error("One-time code has had too many failed attempts.") as never,
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { POST } = await import("../route");
      const response = await POST(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: "Too many failed attempts. Start a new verification challenge.",
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
