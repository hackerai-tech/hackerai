import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("server-only", () => ({}));

const mockEvent = jest.fn();
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: mockEvent } }));

const {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentAvailabilityEventUuid,
  subagentCreateAttemptEventUuid,
  subagentCreateFailureEventUuid,
  subagentModelPromotionEventUuid,
  subagentOperationEventUuid,
  subagentOutcomeEventUuid,
  subagentParentFinishBlockedEventUuid,
  subagentParentSettlementEventUuid,
  subagentResultClaimedEventUuid,
  subagentResultDeliveredEventUuid,
  subagentResultInjectedEventUuid,
} = require("../subagents") as typeof import("../subagents");

describe("subagent lifecycle analytics", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records availability once per parent run without user content", () => {
    captureSubagentLifecycleEvent("subagent_available", {
      userId: "user-1",
      eventUuid: subagentAvailabilityEventUuid("parent-1"),
      parentTriggerRunId: "parent-1",
      profile: "security_validation",
    });

    expect(mockEvent).toHaveBeenCalledWith("subagent_available", {
      userId: "user-1",
      eventUuid: subagentAvailabilityEventUuid("parent-1"),
      subagent_id: undefined,
      parent_trigger_run_id: "parent-1",
      profile: "security_validation",
      status: undefined,
      verdict: undefined,
      duration_ms: undefined,
      step_count: undefined,
      cost_dollars: undefined,
      error_category: undefined,
      runtime_error_category: undefined,
      model_from: undefined,
      model_to: undefined,
      model_promotion_reason: undefined,
      task_status: undefined,
      outcome: undefined,
      failure_stage: undefined,
      active_count: undefined,
      total_count: undefined,
      terminal_count: undefined,
      undelivered_count: undefined,
      target_count: undefined,
      result_available: undefined,
      result_recovery_count: undefined,
      result_submission_count: undefined,
      environment: expect.any(String),
      service_version: expect.any(String),
    });
  });

  it("uses one stable create-attempt id per parent tool call", () => {
    expect(subagentCreateAttemptEventUuid("parent-1", "tool-1")).toBe(
      subagentCreateAttemptEventUuid("parent-1", "tool-1"),
    );
    expect(subagentCreateAttemptEventUuid("parent-1", "tool-1")).not.toBe(
      subagentCreateAttemptEventUuid("parent-1", "tool-2"),
    );
  });

  it("keeps classified failure and coordination outcome ids stable", () => {
    expect(
      subagentCreateFailureEventUuid("parent-1", "tool-1", "security_task"),
    ).toBe(
      subagentCreateFailureEventUuid("parent-1", "tool-1", "security_task"),
    );
    expect(subagentOperationEventUuid("parent-1", "tool-1", "wait")).not.toBe(
      subagentOperationEventUuid("parent-1", "tool-1", "cancel"),
    );
  });

  it("deduplicates parent settlement measurements per parent run", () => {
    expect(subagentParentSettlementEventUuid("parent-1")).toBe(
      subagentParentSettlementEventUuid("parent-1"),
    );
    expect(subagentParentSettlementEventUuid("parent-1")).not.toBe(
      subagentParentSettlementEventUuid("parent-2"),
    );
  });

  it("records parent settlement result-consumption counts", () => {
    captureSubagentLifecycleEvent("subagent_parent_settlement", {
      userId: "user-1",
      eventUuid: subagentParentSettlementEventUuid("parent-1"),
      parentTriggerRunId: "parent-1",
      outcome: "parent_run_ended",
      totalCount: 3,
      activeCount: 0,
      terminalCount: 3,
      undeliveredCount: 2,
      resultAvailable: true,
    });

    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_parent_settlement",
      expect.objectContaining({
        total_count: 3,
        active_count: 0,
        terminal_count: 3,
        undelivered_count: 2,
        result_available: true,
      }),
    );
  });

  it("records specialist skill adoption without user content", () => {
    captureSubagentLifecycleEvent("subagent_spawned", {
      userId: "user-1",
      parentTriggerRunId: "parent-1",
      profile: "security_task",
      skillCount: 2,
    });

    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_spawned",
      expect.objectContaining({
        profile: "security_task",
        skill_count: 2,
      }),
    );
  });

  it("records privacy-safe operation outcomes and release correlation", () => {
    captureSubagentLifecycleEvent("subagent_wait_outcome", {
      userId: "user-1",
      eventUuid: subagentOperationEventUuid("parent-1", "tool-1", "wait"),
      parentTriggerRunId: "parent-1",
      profile: "security_task",
      status: "completed",
      outcome: "agent finished with unsafe spaces",
      activeCount: 0,
      targetCount: 1,
      resultAvailable: true,
      durationMs: 1200,
    });

    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_wait_outcome",
      expect.objectContaining({
        outcome: "agent_finished_with_unsafe_spaces",
        active_count: 0,
        target_count: 1,
        result_available: true,
        duration_ms: 1200,
        environment: expect.any(String),
        service_version: expect.any(String),
      }),
    );
  });

  it("deduplicates repeated targeted delivery of the same child result", () => {
    expect(subagentResultDeliveredEventUuid("sa_1")).toBe(
      subagentResultDeliveredEventUuid("sa_1"),
    );
    expect(subagentResultDeliveredEventUuid("sa_1")).not.toBe(
      subagentResultDeliveredEventUuid("sa_2"),
    );
  });

  it("keeps every acknowledged delivery stage stable and distinct", () => {
    expect(subagentResultClaimedEventUuid("sa_1", "claim_1")).toBe(
      subagentResultClaimedEventUuid("sa_1", "claim_1"),
    );
    expect(subagentResultClaimedEventUuid("sa_1", "claim_1")).not.toBe(
      subagentResultClaimedEventUuid("sa_1", "claim_2"),
    );
    expect(subagentResultInjectedEventUuid("sa_1")).not.toBe(
      subagentResultDeliveredEventUuid("sa_1"),
    );
    expect(subagentParentFinishBlockedEventUuid("parent-1")).toBe(
      subagentParentFinishBlockedEventUuid("parent-1"),
    );
  });

  it("keeps availability ids distinct by profile", () => {
    expect(subagentAvailabilityEventUuid("parent-1", "security_task")).not.toBe(
      subagentAvailabilityEventUuid("parent-1", "security_validation"),
    );
  });

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
      errorCategory: "structured_result_recovery_exhausted",
      runtimeErrorCategory: "unknown",
    });

    expect(mockEvent).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith(
      "subagent_completed",
      expect.objectContaining({
        status: "failed",
        error_category: "structured_result_recovery_exhausted",
        runtime_error_category: "unknown",
      }),
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
