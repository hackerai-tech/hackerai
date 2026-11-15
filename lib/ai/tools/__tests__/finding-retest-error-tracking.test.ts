/** @jest-environment node */
import { beforeEach, expect, it, jest } from "@jest/globals";
import type { ToolContext } from "@/types";

const mockCaptureException = jest.fn();
const mockEmitLog = jest.fn(() => true);
const mockStart = jest.fn<(...args: unknown[]) => Promise<never>>();

// Keep the actual tool catch and phLogger implementation together. Replace
// only remote persistence and the outbound telemetry transports.
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));
jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: (...args: unknown[]) => mockEmitLog(...args),
}));
jest.mock("@/lib/findings/retest-policy", () => ({
  isFindingRetestsEnabled: async () => true,
}));
jest.mock("@/lib/findings/agent-retest-service", () => ({
  startAgentRetest: (...args: unknown[]) => mockStart(...args),
}));
jest.mock("@/lib/findings/semantic-dedupe", () => ({
  createFindingWithDedupe: jest.fn(),
}));
jest.mock("@/lib/db/actions", () => ({
  listReports: jest.fn(),
  getReport: jest.fn(),
  updateFinding: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

it("delivers a caught retest failure to Error Tracking and logs without private error content", async () => {
  const privateContent = "PRIVATE_TARGET_EVIDENCE_AND_CREDENTIAL";
  const caught = Object.assign(new Error(privateContent), {
    name: privateContent,
    stack: privateContent,
    cause: { body: privateContent },
  });
  mockStart.mockRejectedValueOnce(caught);
  const { createStartFindingRetest } = await import("../finding-retests");
  const result = await createStartFindingRetest({
    userID: "user_fixture",
    chatId: "chat_fixture",
    assistantMessageId: "message_fixture",
    triggerRunId: "run_fixture",
  } as ToolContext).execute!(
    { finding_id: "finding_fixture", expected_updated_at: 42 },
    { toolCallId: "call_fixture", messages: [] },
  );

  expect(result).toMatchObject({ success: false, error: "general" });
  expect(mockCaptureException).toHaveBeenCalledTimes(1);
  const [exception, distinctId, properties] =
    mockCaptureException.mock.calls[0];
  expect(exception).toMatchObject({
    name: "FindingRetestToolError",
    message: "Finding retest tool failed",
  });
  expect(exception).not.toBe(caught);
  expect(exception).not.toHaveProperty("cause");
  expect(distinctId).toBe("user_fixture");
  expect(properties).toMatchObject({
    event: "finding_retest_tool_failed",
    operation: "start_finding_retest",
    stage: "start_save",
    chat_id: "chat_fixture",
    assistant_message_id: "message_fixture",
    trigger_run_id: "run_fixture",
  });
  expect(mockEmitLog).toHaveBeenCalledTimes(1);
  expect(mockEmitLog).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      event: "finding_retest_tool_failed",
      attributes: expect.objectContaining({
        operation: "start_finding_retest",
      }),
    }),
  );
  expect(
    JSON.stringify([mockCaptureException.mock.calls, mockEmitLog.mock.calls]),
  ).not.toContain(privateContent);
  expect(JSON.stringify(properties)).not.toContain("finding_fixture");
});
