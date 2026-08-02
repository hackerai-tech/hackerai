import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const createPublicToken = jest.fn<any>();
jest.mock("@trigger.dev/sdk", () => ({
  auth: {
    createPublicToken: (...args: unknown[]) => createPublicToken(...args),
  },
}));

const getUserID = jest.fn<any>();
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: (...args: unknown[]) => getUserID(...args),
}));

const getOwnedSubagent = jest.fn<any>();
jest.mock("@/lib/db/subagents", () => ({
  getOwnedSubagent: (...args: unknown[]) => getOwnedSubagent(...args),
}));

const { POST } = require("../route") as typeof import("../route");

describe("subagent realtime token route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserID.mockResolvedValue("user-1");
    getOwnedSubagent.mockResolvedValue({ trigger_run_id: "child-run-1" });
    createPublicToken.mockResolvedValue("scoped-token");
  });

  it("mints a short-lived read token for exactly the owned child run", async () => {
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        accessToken: "scoped-token",
        runId: "child-run-1",
        streamId: "ui",
        expiresInSeconds: 600,
      }),
    );
    expect(getOwnedSubagent).toHaveBeenCalledWith("sa_1", "user-1");
    expect(createPublicToken).toHaveBeenCalledWith({
      scopes: { read: { runs: ["child-run-1"] } },
      expirationTime: "600s",
    });
  });

  it("does not reveal a child that the authenticated user does not own", async () => {
    getOwnedSubagent.mockRejectedValue(new Error("not owned"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_other" }),
    });

    expect(response.status).toBe(404);
    expect(createPublicToken).not.toHaveBeenCalled();
  });

  it("does not mint a token before the Trigger run is attached", async () => {
    getOwnedSubagent.mockResolvedValue({});
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_queued" }),
    });

    expect(response.status).toBe(409);
    expect(createPublicToken).not.toHaveBeenCalled();
  });

  it("returns 401 when authentication fails", async () => {
    getUserID.mockRejectedValue(new Error("unauthenticated"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(401);
    expect(getOwnedSubagent).not.toHaveBeenCalled();
  });

  it("returns a server error when token creation fails", async () => {
    createPublicToken.mockRejectedValue(new Error("Trigger unavailable"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(502);
  });
});
