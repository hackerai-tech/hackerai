import {
  AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
  AGENT_AUTO_REVIEW_FEATURE_PROPERTY,
  AGENT_AUTO_REVIEW_FLAG_KEY,
  evaluateAgentAutoReviewFlag,
} from "@/lib/experiments/agent-auto-review";

describe("Agent Auto review flag", () => {
  it.each(["shadow", "enforce"] as const)(
    "accepts the %s rollout phase and captures privacy-safe exposure",
    async (phase) => {
      const posthog = {
        evaluateFlags: jest.fn(async () => ({
          getFlag: jest.fn(() => phase),
        })),
        capture: jest.fn(),
      };

      await expect(
        evaluateAgentAutoReviewFlag({
          posthog: posthog as never,
          userId: "user-1",
          captureExposure: true,
        }),
      ).resolves.toEqual({ key: AGENT_AUTO_REVIEW_FLAG_KEY, phase });
      expect(posthog.capture).toHaveBeenCalledWith({
        distinctId: "user-1",
        event: AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
        properties: {
          rollout_phase: phase,
          surface: "agent_permission_selector",
          [AGENT_AUTO_REVIEW_FEATURE_PROPERTY]: phase,
          $process_person_profile: false,
        },
      });
    },
  );

  it.each([false, true, "control", undefined])(
    "fails closed for an unsupported assignment: %p",
    async (value) => {
      const posthog = {
        evaluateFlags: jest.fn(async () => ({ getFlag: () => value })),
        capture: jest.fn(),
      };
      await expect(
        evaluateAgentAutoReviewFlag({
          posthog: posthog as never,
          userId: "user-1",
        }),
      ).resolves.toBeUndefined();
      expect(posthog.capture).not.toHaveBeenCalled();
    },
  );
});
