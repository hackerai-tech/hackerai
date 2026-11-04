import { clearFinishedAgentRun } from "../agent-run-cleanup";

const mockSetActiveTriggerRun = jest.fn();
jest.mock("@/lib/db/actions", () => ({
  setActiveTriggerRun: (...args: unknown[]) => mockSetActiveTriggerRun(...args),
}));

beforeEach(() => jest.resetAllMocks());

it("retains the run and session for retry when session closure failed or is still pending", async () => {
  await clearFinishedAgentRun({
    chatId: "chat",
    triggerRunId: "old-run",
    approvalSessionId: "old-session",
    approvalSessionClosed: false,
  });
  expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
});

it("clears only the matching run and session after closure succeeds", async () => {
  await clearFinishedAgentRun({
    chatId: "chat",
    triggerRunId: "old-run",
    approvalSessionId: "old-session",
    approvalSessionClosed: true,
  });
  expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
    chatId: "chat",
    triggerRunId: null,
    approvalSessionId: null,
    expectedRunId: "old-run",
    expectedApprovalSessionId: "old-session",
    clearApprovalPending: true,
  });
});

it("still detaches runs that never needed an approval session", async () => {
  await clearFinishedAgentRun({
    chatId: "chat",
    triggerRunId: "run",
    approvalSessionClosed: false,
  });
  expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
    expect.objectContaining({
      triggerRunId: null,
      expectedRunId: "run",
    }),
  );
});
