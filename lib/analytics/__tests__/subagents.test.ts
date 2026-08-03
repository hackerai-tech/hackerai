import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("server-only", () => ({}));

const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: mockEvent } }));

const {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentModelPromotionEventUuid,
  subagentOutcomeEventUuid,
} = require("../subagents") as typeof import("../subagents");

describe("subagent lifecycle analytics", () => {
  beforeEach(() => jest.clearAllMocks());

  it("emits exactly one canceled outcome with a stable event id", () => {
    captureSubagentTerminalOutcome({
      userId: "user-1",
      subagentId: "sa_1",
      parentTriggerRunId: "parent-1",
      profile: "security_validation",
      status: "canceled",
      errorCategory: "parent_or_user_canceled",
    });

    expect(mockEvent).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_canceled",
      expect.objectContaining({
        eventUuid: subagentOutcomeEventUuid("sa_1"),
        status: "canceled",
      }),
    );
  });

  it("uses the completed outcome for non-cancellation failures", () => {
    captureSubagentTerminalOutcome({
      userId: "user-1",
      subagentId: "sa_2",
      parentTriggerRunId: "parent-1",
      profile: "security_validation",
      status: "failed",
      errorCategory: "runtime_error",
    });

    expect(mockEvent).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_completed",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("records privacy-safe one-way model promotion metadata", () => {
    captureSubagentLifecycleEvent("subagent_model_promoted", {
      userId: "user-1",
      eventUuid: subagentModelPromotionEventUuid("sa_3"),
      subagentId: "sa_3",
      parentTriggerRunId: "parent-1",
      profile: "security_validation",
      modelFrom: "agent-model-free",
      modelTo: "model-grok-4.5",
      modelPromotionReason: "image_tool_result",
    });

    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_model_promoted",
      expect.objectContaining({
        eventUuid: subagentModelPromotionEventUuid("sa_3"),
        model_from: "agent-model-free",
        model_to: "model-grok-4_5",
        model_promotion_reason: "image_tool_result",
      }),
    );
  });
});
