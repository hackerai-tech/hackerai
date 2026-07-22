import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  applyAskToAgentApprovalExperiment,
  ASK_TO_AGENT_APPROVAL_EXPERIMENT_KEY,
  ASK_TO_AGENT_APPROVAL_EXPOSURE_EVENT,
  ASK_TO_AGENT_APPROVAL_FLAG_KEY,
  hasAskToAgentApprovalExposure,
} from "../ask-to-agent-approval";

describe("applyAskToAgentApprovalExperiment", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("records exposure before moving a paid cohort user to Agent with approval", () => {
    const captureExposure = jest.fn(() => true);
    const setAgentPermissionMode = jest.fn();
    const setChatMode = jest.fn();

    const applied = applyAskToAgentApprovalExperiment({
      agentPermissionMode: "full_access",
      captureExposure,
      chatMode: "ask",
      enabled: true,
      now: () => new Date("2026-07-22T14:00:00.000Z"),
      setAgentPermissionMode,
      setChatMode,
      subscription: "pro",
      temporaryChatsEnabled: false,
      userId: "user-123",
    });

    expect(applied).toBe(true);
    expect(captureExposure).toHaveBeenCalledWith(
      ASK_TO_AGENT_APPROVAL_EXPOSURE_EVENT,
      expect.objectContaining({
        experiment_key: ASK_TO_AGENT_APPROVAL_EXPERIMENT_KEY,
        feature_flag_key: ASK_TO_AGENT_APPROVAL_FLAG_KEY,
        variant: "agent_ask_approval",
        previous_chat_mode: "ask",
        previous_agent_permission_mode: "full_access",
        mode: "agent",
        agent_permission_mode: "ask_approval",
        eligible_user_denominator: 452,
        cohort_user_count: 113,
        rollout_percentage: 25,
        $set_once: {
          ask_to_agent_approval_experiment_variant: "agent_ask_approval",
          ask_to_agent_approval_experiment_exposed_at:
            "2026-07-22T14:00:00.000Z",
        },
      }),
      { uuid: expect.any(String) },
    );
    expect(setAgentPermissionMode).toHaveBeenCalledWith("ask_approval");
    expect(setChatMode).toHaveBeenCalledWith("agent");
    expect(hasAskToAgentApprovalExposure("user-123")).toBe(true);
  });

  it("does not change behavior unless the exposure event can be queued", () => {
    const setAgentPermissionMode = jest.fn();
    const setChatMode = jest.fn();

    const applied = applyAskToAgentApprovalExperiment({
      agentPermissionMode: "full_access",
      captureExposure: jest.fn(() => false),
      chatMode: "ask",
      enabled: true,
      setAgentPermissionMode,
      setChatMode,
      subscription: "ultra",
      temporaryChatsEnabled: false,
      userId: "user-123",
    });

    expect(applied).toBe(false);
    expect(setAgentPermissionMode).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
    expect(hasAskToAgentApprovalExposure("user-123")).toBe(false);
  });

  it("applies only once so users can return to Ask without being forced back", () => {
    const captureExposure = jest.fn(() => true);
    const setAgentPermissionMode = jest.fn();
    const setChatMode = jest.fn();
    const base = {
      captureExposure,
      enabled: true,
      setAgentPermissionMode,
      setChatMode,
      subscription: "pro-plus" as const,
      temporaryChatsEnabled: false,
      userId: "user-123",
    };

    expect(
      applyAskToAgentApprovalExperiment({
        ...base,
        agentPermissionMode: "full_access",
        chatMode: "ask",
      }),
    ).toBe(true);

    setAgentPermissionMode.mockClear();
    setChatMode.mockClear();

    expect(
      applyAskToAgentApprovalExperiment({
        ...base,
        agentPermissionMode: "ask_approval",
        chatMode: "ask",
      }),
    ).toBe(false);
    expect(captureExposure).toHaveBeenCalledTimes(1);
    expect(setAgentPermissionMode).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, subscription: "pro" as const, temporary: false },
    { enabled: true, subscription: "free" as const, temporary: false },
    { enabled: true, subscription: "ultra" as const, temporary: true },
  ])(
    "skips users outside the live paid non-temporary exposure path",
    ({ enabled, subscription, temporary }) => {
      const captureExposure = jest.fn(() => true);

      expect(
        applyAskToAgentApprovalExperiment({
          agentPermissionMode: "full_access",
          captureExposure,
          chatMode: "ask",
          enabled,
          setAgentPermissionMode: jest.fn(),
          setChatMode: jest.fn(),
          subscription,
          temporaryChatsEnabled: temporary,
          userId: "user-123",
        }),
      ).toBe(false);
      expect(captureExposure).not.toHaveBeenCalled();
    },
  );
});
