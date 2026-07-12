import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCancelAgentTriggerRun = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();

jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: mockCancelAgentTriggerRun,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

const { closeAndCancelAgentResources } =
  require("../agent-deletion-cleanup") as typeof import("../agent-deletion-cleanup");

describe("closeAndCancelAgentResources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelAgentTriggerRun.mockResolvedValue(true as never);
    mockCloseAgentApprovalSession.mockResolvedValue(true as never);
  });

  it("deduplicates and cleans run and Session ids independently", async () => {
    await expect(
      closeAndCancelAgentResources(
        [
          {
            chatId: "chat-1",
            triggerRunId: "run-1",
            approvalSessionId: "approval-session-1",
          },
          { chatId: "chat-2", triggerRunId: "run-1" },
          {
            chatId: "chat-3",
            approvalSessionId: "approval-session-2",
          },
        ],
        "account-deleted",
      ),
    ).resolves.toEqual({
      canceledTriggerRuns: 1,
      closedApprovalSessions: 2,
    });
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledTimes(1);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledTimes(2);
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-2",
      "account-deleted",
    );
  });

  it("rejects when any resource cannot be cleaned", async () => {
    mockCloseAgentApprovalSession.mockRejectedValueOnce(
      new Error("Session API unavailable") as never,
    );

    await expect(
      closeAndCancelAgentResources(
        [
          {
            chatId: "chat-1",
            triggerRunId: "run-1",
            approvalSessionId: "approval-session-1",
          },
        ],
        "chat-deleted",
      ),
    ).rejects.toThrow("Session API unavailable");
  });
});
