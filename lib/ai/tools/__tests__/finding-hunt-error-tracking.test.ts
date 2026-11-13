/** @jest-environment node */
import { beforeEach, expect, it, jest } from "@jest/globals";
import type { ToolContext } from "@/types";

const mockCaptureException = jest.fn();
const mockEmitLog = jest.fn(() => true);
const mockRecord = jest.fn<(...args: unknown[]) => Promise<never>>();

// Keep the actual tool catch and phLogger implementation together. Replace
// only remote persistence and the outbound telemetry transports.
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));
jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: (...args: unknown[]) => mockEmitLog(...args),
}));
jest.mock("@/lib/findings/hunt-policy", () => ({
  isFindingHuntsEnabled: async () => true,
}));
jest.mock("@/lib/findings/hunt-service", () => ({
  recordFindingHuntCandidate: (...args: unknown[]) => mockRecord(...args),
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

it("delivers a caught candidate failure to Error Tracking and logs without private content", async () => {
  const privateContent = "PRIVATE_TARGET_EVIDENCE_AND_CREDENTIAL";
  const caught = Object.assign(new Error(privateContent), {
    name: privateContent,
    stack: privateContent,
    cause: { body: privateContent },
  });
  mockRecord.mockRejectedValueOnce(caught);
  const { createRecordFindingHuntCandidate } = await import("../finding-hunts");
  const result = await createRecordFindingHuntCandidate({
    userID: "user_fixture",
    chatId: "chat_fixture",
    assistantMessageId: "message_fixture",
    triggerRunId: "run_fixture",
  } as ToolContext).execute!(
    {
      finding_id: "finding_fixture",
      candidate_key: "invoice-pdf",
      surface: "GET /api/invoices/{id}/pdf",
      rationale: "Same loader without an owner check.",
      outcome: "reproduced",
      evidence_basis: "runtime_check",
      reproduction_steps: ["Tester B's PDF as tester A"],
      expected_result: "403",
      observed_result: "200 with tester B's PDF",
      limitations: [],
    },
    { toolCallId: "call_fixture", messages: [] },
  );

  expect(result).toMatchObject({ success: false, error: "general" });
  expect(mockCaptureException).toHaveBeenCalledTimes(1);
  const [exception, distinctId, properties] =
    mockCaptureException.mock.calls[0];
  expect(exception).toMatchObject({
    name: "FindingHuntToolError",
    message: "Finding hunt tool failed",
  });
  expect(exception).not.toBe(caught);
  expect(exception).not.toHaveProperty("cause");
  expect(distinctId).toBe("user_fixture");
  expect(properties).toMatchObject({
    event: "finding_hunt_tool_failed",
    operation: "record_finding_hunt_candidate",
    stage: "candidate_save",
    chat_id: "chat_fixture",
    assistant_message_id: "message_fixture",
    trigger_run_id: "run_fixture",
  });
  expect(mockEmitLog).toHaveBeenCalledTimes(1);
  const delivered = JSON.stringify([
    mockCaptureException.mock.calls,
    mockEmitLog.mock.calls,
  ]);
  for (const value of [privateContent, "finding_fixture", "invoice"])
    expect(delivered).not.toContain(value);
});
