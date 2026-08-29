import {
  AGENT_FULL_ACCESS_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG,
  AGENT_LIGHTWEIGHT_REQUEST_MAX_BYTES,
  getAgentLightweightMachineEligibility,
  getAgentMachineRoutingExposure,
  getAgentMachineRoutingExperiment,
  getAgentMachineRoutingFlagBeforeDeadline,
  getBaselineAgentTriggerMachine,
  resolveAgentMachineRouting,
} from "@/lib/experiments/agent-machine-routing";
import type { SubscriptionTier } from "@/types";

const eligibleInput = {
  subscription: "pro" as const,
  isNewChat: true,
  regenerate: false,
  isAutoContinue: false,
  isAutomaticContinuation: false,
  hasLimitRescue: false,
  requestMessageCount: 1,
  requestMessageBytes: 1_024,
  hasFileAttachment: false,
  localDesktopAttachmentsPrepared: false,
  hasProjectContext: false,
  hasTodos: false,
};

describe("Agent machine routing", () => {
  it.each([
    ["free", "small-1x"],
    ["pro", "small-2x"],
    ["pro-plus", "small-2x"],
    ["ultra", "small-2x"],
    ["team", "small-2x"],
  ] as const)("keeps the %s baseline on %s", (subscription, machine) => {
    expect(getBaselineAgentTriggerMachine(subscription)).toBe(machine);
  });

  it.each(["pro", "pro-plus"] as const)(
    "allows a conservative lightweight %s first turn",
    (subscription) => {
      expect(
        getAgentLightweightMachineEligibility({
          ...eligibleInput,
          subscription,
        }),
      ).toEqual({ eligible: true, reason: "eligible" });
    },
  );

  it.each([
    ["free", { subscription: "free" }, "unsupported_subscription"],
    ["ultra", { subscription: "ultra" }, "unsupported_subscription"],
    ["team", { subscription: "team" }, "unsupported_subscription"],
    ["existing chat", { isNewChat: false }, "existing_chat"],
    ["regeneration", { regenerate: true }, "regenerate"],
    ["auto-continue", { isAutoContinue: true }, "auto_continue"],
    [
      "automatic continuation",
      { isAutomaticContinuation: true },
      "automatic_continuation",
    ],
    ["limit rescue", { hasLimitRescue: true }, "limit_rescue"],
    [
      "multiple request messages",
      { requestMessageCount: 2 },
      "request_message_count",
    ],
    [
      "oversized request",
      { requestMessageBytes: AGENT_LIGHTWEIGHT_REQUEST_MAX_BYTES + 1 },
      "request_too_large",
    ],
    ["file attachment", { hasFileAttachment: true }, "file_attachment"],
    [
      "desktop-local attachment",
      { localDesktopAttachmentsPrepared: true },
      "desktop_local_attachment",
    ],
    ["project context", { hasProjectContext: true }, "project_context"],
    ["existing todos", { hasTodos: true }, "existing_todos"],
  ] as const)("excludes %s", (_name, overrides, reason) => {
    expect(
      getAgentLightweightMachineEligibility({
        ...eligibleInput,
        ...overrides,
        subscription:
          (overrides as { subscription?: SubscriptionTier }).subscription ??
          eligibleInput.subscription,
      }),
    ).toEqual({ eligible: false, reason });
  });

  it("keeps standard and full-access first turns in independent cohorts", () => {
    const eligibility = { eligible: true, reason: "eligible" } as const;

    expect(
      getAgentMachineRoutingExperiment({
        eligibility,
        isFullAccessParent: false,
      }),
    ).toEqual({
      cohort: "standard",
      featureFlagKey: "agent_lightweight_small_1x_v1",
    });
    expect(
      getAgentMachineRoutingExperiment({
        eligibility,
        isFullAccessParent: true,
      }),
    ).toEqual({
      cohort: "full_access",
      featureFlagKey: AGENT_FULL_ACCESS_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG,
    });
    expect(
      getAgentMachineRoutingExperiment({
        eligibility: { eligible: false, reason: "existing_chat" },
        isFullAccessParent: true,
      }),
    ).toBeUndefined();
  });

  it("keeps eligible control users on small-2x", () => {
    expect(
      resolveAgentMachineRouting({
        subscription: "pro",
        eligibility: { eligible: true, reason: "eligible" },
        lightweightSmall1xEnabled: false,
      }),
    ).toEqual({
      eligible: true,
      reason: "eligible",
      variant: "control",
      machine: "small-2x",
    });
  });

  it("routes only eligible treatment users to small-1x", () => {
    expect(
      resolveAgentMachineRouting({
        subscription: "pro-plus",
        eligibility: { eligible: true, reason: "eligible" },
        lightweightSmall1xEnabled: true,
      }),
    ).toEqual({
      eligible: true,
      reason: "eligible",
      variant: "test",
      machine: "small-1x",
    });

    expect(
      resolveAgentMachineRouting({
        subscription: "ultra",
        eligibility: {
          eligible: false,
          reason: "unsupported_subscription",
        },
        lightweightSmall1xEnabled: true,
      }),
    ).toEqual({
      eligible: false,
      reason: "unsupported_subscription",
      variant: "ineligible",
      machine: "small-2x",
    });
  });

  it("fails closed when PostHog misses the routing deadline", async () => {
    await expect(
      getAgentMachineRoutingFlagBeforeDeadline(
        new Promise<boolean>(() => {}),
        1,
      ),
    ).resolves.toBe(false);
    await expect(
      getAgentMachineRoutingFlagBeforeDeadline(Promise.resolve(true), 100),
    ).resolves.toBe(true);
    await expect(
      getAgentMachineRoutingFlagBeforeDeadline(
        Promise.reject(new Error("PostHog unavailable")),
        100,
      ),
    ).resolves.toBe(false);
  });

  it("builds a privacy-safe exposure only for eligible scheduled runs", () => {
    const exposure = getAgentMachineRoutingExposure({
      decision: {
        eligible: true,
        reason: "eligible",
        variant: "test",
        machine: "small-1x",
      },
      experiment: {
        cohort: "full_access",
        featureFlagKey: AGENT_FULL_ACCESS_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG,
      },
      subscription: "pro",
      endpoint: "/api/agent",
      runId: "run_123",
      isNewChat: true,
      requestMessageCount: 1,
      requestMessageBytes: 1_024,
      requestHasFileAttachments: false,
      localDesktopAttachmentsPrepared: false,
    });

    expect(exposure).toEqual({
      event: "agent_machine_routing_exposed",
      properties: expect.objectContaining({
        experiment_key: "agent_full_access_lightweight_small_1x_v1",
        experiment_variant: "test",
        "$feature/agent_full_access_lightweight_small_1x_v1": true,
        machine_routing_cohort: "full_access",
        trigger_run_id: "run_123",
        selected_machine: "small-1x",
        request_message_bytes: 1_024,
        $process_person_profile: false,
      }),
    });
    expect(JSON.stringify(exposure)).not.toContain("prompt");
    expect(JSON.stringify(exposure)).not.toContain("filename");

    expect(
      getAgentMachineRoutingExposure({
        decision: {
          eligible: false,
          reason: "existing_chat",
          variant: "ineligible",
          machine: "small-2x",
        },
        experiment: undefined,
        subscription: "pro",
        endpoint: "/api/agent",
        runId: "run_456",
        isNewChat: false,
        requestMessageCount: 1,
        requestMessageBytes: 1_024,
        requestHasFileAttachments: false,
        localDesktopAttachmentsPrepared: false,
      }),
    ).toBeUndefined();
  });
});
