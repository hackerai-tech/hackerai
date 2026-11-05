import { observeFindingTool } from "../finding-telemetry";
import { findingEventProperties } from "@/lib/findings/telemetry";
import { phLogger } from "@/lib/posthog/server";
import type { ToolContext } from "@/types";
import type { ToolExecutionOptions } from "ai";

jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
const context = {
  userID: "test-user",
  assistantMessageId: "message",
  triggerRunId: "run-1",
  mode: "agent",
} as ToolContext;
const options = { toolCallId: "tool-1" } as ToolExecutionOptions;
beforeEach(() => jest.clearAllMocks());
it.each([
  [{ success: false, error: "conflict" }, "rejected", "conflict"],
  [
    { success: false, error: "validation", validation_kind: "evidence" },
    "rejected",
    "evidence",
  ],
  [
    { success: false, error: "general", message: "private failure body" },
    "uncertain",
    "general",
  ],
])(
  "classifies returned write outcomes without capturing content",
  async (result, outcome, reason) => {
    const execute = observeFindingTool(
      context,
      "update",
      () => null,
      async () => result,
    );
    await expect(
      execute({ evidence: "PRIVATE REQUEST" }, options),
    ).resolves.toEqual(result);
    expect(phLogger.event).toHaveBeenCalledWith(
      "finding_operation_completed",
      expect.objectContaining({
        operation: "update",
        outcome,
        reason,
        trigger_run_id: "run-1",
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.event).mock.calls)).not.toMatch(
      /PRIVATE|private failure/,
    );
  },
);
it("distinguishes missing provenance and cancellation from uncertain writes", async () => {
  await observeFindingTool(
    { ...context, assistantMessageId: undefined },
    "create",
    () => null,
    async () => ({ success: false, error: "general" }),
  )({}, options);
  expect(phLogger.event).toHaveBeenLastCalledWith(
    "finding_operation_completed",
    expect.objectContaining({ outcome: "rejected", reason: "provenance" }),
  );
  const abort = new AbortController();
  abort.abort();
  const execute = observeFindingTool(
    context,
    "update",
    () => null,
    async () => {
      abort.signal.throwIfAborted();
      return { success: true };
    },
  );
  await expect(
    execute({}, { ...options, abortSignal: abort.signal }),
  ).rejects.toBeDefined();
  expect(phLogger.event).toHaveBeenLastCalledWith(
    "finding_operation_completed",
    expect.objectContaining({ outcome: "canceled" }),
  );
});
it("cannot turn a saved write into failure when telemetry throws", async () => {
  jest.mocked(phLogger.event).mockImplementationOnce(() => {
    throw new Error("analytics unavailable");
  });
  await expect(
    observeFindingTool(
      context,
      "create",
      () => null,
      async () => ({ success: true, finding_id: "opaque-id" }),
    )({}, options),
  ).resolves.toEqual({ success: true, finding_id: "opaque-id" });
});
it("projects only approved event properties", () => {
  const event = {
    operation: "search" as const,
    outcome: "success" as const,
    has_search: true,
    result_count: 0,
    query: "private target",
    report: { evidence: "private" },
    error: "private exception",
  };
  expect(findingEventProperties(event)).toEqual({
    finding_event_version: 1,
    operation: "search",
    outcome: "success",
    has_search: true,
    result_count: 0,
  });
});
