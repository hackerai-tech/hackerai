import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const getUserIDAndPro = jest.fn<any>();
const getChatById = jest.fn<any>();
const retrieveRun = jest.fn<any>();
const retrieveToken = jest.fn<any>();
const completeToken = jest.fn<any>();
const claimReply = jest.fn<any>();
const listMemberships = jest.fn<any>();

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;
    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }
    async json() {
      return this.body;
    }
  },
}));
jest.mock("@trigger.dev/sdk", () => ({
  runs: { retrieve: retrieveRun },
  wait: { retrieveToken, completeToken },
}));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro }));
jest.mock("@/lib/db/actions", () => ({ getChatById }));
jest.mock("@/lib/db/agent-user-wait", () => ({
  claimAgentUserWaitReply: claimReply,
}));
jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: { listOrganizationMemberships: listMemberships },
  },
}));
jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => ({ status: 500 })),
}));

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    json: async () => ({
      chatId: "chat-1",
      runId: "run-1",
      toolCallId: "tool-1",
      text: "Proceed with option A",
      ...overrides,
    }),
  }) as any;

const post = async (input = request()) => {
  const { createAgentUserReplyPost } =
    await import("../agent-user-reply-route");
  return createAgentUserReplyPost({ endpoint: "/api/agent" })(input);
};

describe("Agent wait_for_user reply", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "pro",
    });
    getChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_user_wait: {
        runId: "run-1",
        toolCallId: "tool-1",
        tokenId: "waitpoint-1",
        status: "waiting",
      },
    });
    retrieveRun.mockResolvedValue({
      status: "EXECUTING",
      metadata: { userId: "user-1", chatId: "chat-1" },
    });
    retrieveToken.mockResolvedValue({ status: "WAITING" });
    completeToken.mockResolvedValue({ success: true });
    claimReply.mockResolvedValue("claimed");
    listMemberships.mockResolvedValue({ data: [{}] });
  });

  it("delivers the reply only to the matching token and run", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(completeToken).toHaveBeenCalledWith(
      "waitpoint-1",
      expect.objectContaining({
        chatId: "chat-1",
        userId: "user-1",
        runId: "run-1",
        toolCallId: "tool-1",
        text: "Proceed with option A",
      }),
    );
    expect(claimReply).toHaveBeenCalledTimes(1);
  });

  it("rejects a different owner before inspecting the run or token", async () => {
    getChatById.mockResolvedValue({
      user_id: "another-user",
      active_trigger_run_id: "run-1",
      active_agent_user_wait: { runId: "run-1", toolCallId: "tool-1" },
    });
    expect((await post()).status).toBe(409);
    expect(retrieveRun).not.toHaveBeenCalled();
    expect(completeToken).not.toHaveBeenCalled();
  });

  it("rejects a stale tool call without claiming the reply", async () => {
    expect((await post(request({ toolCallId: "tool-old" }))).status).toBe(409);
    expect(claimReply).not.toHaveBeenCalled();
  });

  it("asks for a retry while the matching run is still publishing its wait", async () => {
    getChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    });
    expect((await post()).status).toBe(425);
    expect(claimReply).not.toHaveBeenCalled();
  });

  it("rejects a terminal or re-associated run", async () => {
    retrieveRun.mockResolvedValue({
      status: "CANCELED",
      metadata: { userId: "user-1", chatId: "chat-1" },
    });
    expect((await post()).status).toBe(409);
    expect(completeToken).not.toHaveBeenCalled();
  });

  it("accepts the same completed reply on a retry without completing twice", async () => {
    await post();
    const delivered = completeToken.mock.calls[0]?.[1];
    claimReply.mockResolvedValue("duplicate");
    retrieveToken.mockResolvedValue({ status: "COMPLETED", output: delivered });
    expect((await post()).status).toBe(200);
    expect(completeToken).toHaveBeenCalledTimes(1);
  });

  it("recovers the same claimed reply after token retrieval fails", async () => {
    retrieveToken.mockRejectedValueOnce(
      new Error("temporary retrieval failure"),
    );
    expect((await post()).status).toBe(500);
    expect(completeToken).not.toHaveBeenCalled();
    claimReply.mockResolvedValue("duplicate");
    expect((await post()).status).toBe(200);
    expect(claimReply.mock.calls[1][0]).toEqual(claimReply.mock.calls[0][0]);
    expect(completeToken).toHaveBeenCalledTimes(1);
  });

  it("recognizes delivery after a lost completion response without replaying it", async () => {
    completeToken.mockRejectedValueOnce(
      new Error("response lost after delivery"),
    );
    expect((await post()).status).toBe(500);
    const delivered = completeToken.mock.calls[0][1];
    claimReply.mockResolvedValue("duplicate");
    retrieveToken.mockResolvedValue({ status: "COMPLETED", output: delivered });
    expect((await post()).status).toBe(200);
    expect(completeToken).toHaveBeenCalledTimes(1);

    claimReply.mockResolvedValue("busy");
    expect((await post(request({ text: "Different reply" }))).status).toBe(409);
    expect(completeToken).toHaveBeenCalledTimes(1);
  });

  it("requires an active team membership before completing a reply", async () => {
    getUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "team",
      organizationId: "org-1",
    });
    listMemberships.mockResolvedValue({ data: [] });
    expect((await post()).status).toBe(403);
    expect(completeToken).not.toHaveBeenCalled();
  });
});
