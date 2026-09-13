import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const getUserID = jest.fn<any>();
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: (...args: unknown[]) => getUserID(...args),
}));

const cancelAgentTriggerRun = jest.fn<any>();
jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: (...args: unknown[]) => cancelAgentTriggerRun(...args),
}));

const getOwnedSubagent = jest.fn<any>();
const cancelSubagentForUser = jest.fn<any>();
jest.mock("@/lib/db/subagents", () => ({
  getOwnedSubagent: (...args: unknown[]) => getOwnedSubagent(...args),
  cancelSubagentForUser: (...args: unknown[]) => cancelSubagentForUser(...args),
}));

const { POST } = require("../route") as typeof import("../route");

describe("subagent cancel route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserID.mockResolvedValue("user-1");
    getOwnedSubagent.mockResolvedValue({
      status: "running",
      trigger_run_id: "child-run-1",
    });
    cancelAgentTriggerRun.mockResolvedValue(true);
    cancelSubagentForUser.mockResolvedValue(true);
  });

  it("cancels exactly the authenticated user's active child run", async () => {
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(200);
    expect(getOwnedSubagent).toHaveBeenCalledWith("sa_1", "user-1");
    expect(cancelAgentTriggerRun).toHaveBeenCalledWith("child-run-1");
    expect(cancelSubagentForUser).toHaveBeenCalledWith({
      subagentId: "sa_1",
      userId: "user-1",
      triggerRunId: "child-run-1",
      reason: "user_canceled_child",
    });
  });

  it("does not reveal or cancel another user's child", async () => {
    getOwnedSubagent.mockRejectedValue(new Error("not owned"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_other" }),
    });

    expect(response.status).toBe(404);
    expect(cancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(cancelSubagentForUser).not.toHaveBeenCalled();
  });

  it("cancels a queued child before it receives a Trigger run id", async () => {
    getOwnedSubagent.mockResolvedValue({ status: "queued" });
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_queued" }),
    });

    expect(response.status).toBe(200);
    expect(cancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(cancelSubagentForUser).toHaveBeenCalledWith({
      subagentId: "sa_queued",
      userId: "user-1",
      triggerRunId: undefined,
      reason: "user_canceled_child",
    });
    await expect(response.json()).resolves.toEqual({
      canceled: true,
      status: "queued",
    });
  });

  it("follows an attach race and cancels the newly linked Trigger run", async () => {
    getOwnedSubagent
      .mockResolvedValueOnce({ status: "queued" })
      .mockResolvedValueOnce({
        status: "running",
        trigger_run_id: "child-run-late",
      });
    cancelSubagentForUser
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_queued" }),
    });

    expect(response.status).toBe(200);
    expect(cancelAgentTriggerRun).toHaveBeenCalledWith("child-run-late");
    expect(cancelSubagentForUser).toHaveBeenLastCalledWith({
      subagentId: "sa_queued",
      userId: "user-1",
      triggerRunId: "child-run-late",
      reason: "user_canceled_child",
    });
  });

  it("returns a server error without changing persistence when Trigger cancellation fails", async () => {
    cancelAgentTriggerRun.mockRejectedValue(new Error("Trigger unavailable"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(502);
    expect(cancelSubagentForUser).not.toHaveBeenCalled();
  });

  it("surfaces persistence failure after Trigger cancellation", async () => {
    cancelSubagentForUser.mockRejectedValue(new Error("Convex unavailable"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(502);
    expect(cancelAgentTriggerRun).toHaveBeenCalledWith("child-run-1");
  });

  it("returns 401 when authentication fails", async () => {
    getUserID.mockRejectedValue(new Error("unauthenticated"));
    const response = await POST({} as any, {
      params: Promise.resolve({ subagentId: "sa_1" }),
    });

    expect(response.status).toBe(401);
    expect(getOwnedSubagent).not.toHaveBeenCalled();
  });
});
