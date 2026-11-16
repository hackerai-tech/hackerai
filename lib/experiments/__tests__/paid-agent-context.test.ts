import {
  getAgentContextPolicy,
  getPaidAgentContextSelection,
  PAID_AGENT_CONTEXT_FLAG,
  paidAgentContextAnalyticsProperties,
  resolvePaidAgentContextAssignment,
} from "../paid-agent-context";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

const PAID = ["pro", "pro-plus", "ultra", "team"] as const;
const SELECTIONS = [
  undefined,
  "auto",
  "hackerai-standard",
  "hackerai-pro",
  "hackerai-max",
] as const;

const TEST_FLAG = { enabled: true, variant: "test" };
const flagClient = (result: unknown): { getFeatureFlagResult: jest.Mock } => ({
  getFeatureFlagResult: jest.fn(async () => result),
});

const resolve = (
  posthog: ReturnType<typeof flagClient> | null,
  overrides: Partial<{
    subscription: SubscriptionTier;
    mode: ChatMode;
    selectedModelOverride: SelectedModel | undefined;
    userId: string;
  }> = {},
) =>
  resolvePaidAgentContextAssignment({
    posthog: posthog as never,
    userId: "user-1",
    subscription: "pro",
    mode: "agent",
    selectedModelOverride: undefined,
    ...overrides,
  });

describe("paid Agent context eligibility", () => {
  it.each(
    (["free", ...PAID] as const).flatMap((subscription) =>
      (["agent", "ask"] as const).flatMap((mode) =>
        SELECTIONS.map((selected) => ({ subscription, mode, selected })),
      ),
    ),
  )(
    "$subscription $mode selector=$selected",
    async ({ subscription, mode, selected }) => {
      const eligible =
        subscription !== "free" &&
        mode === "agent" &&
        (selected === undefined ||
          selected === "auto" ||
          selected === "hackerai-standard");
      const posthog = flagClient(TEST_FLAG);
      const assignment = await resolve(posthog, {
        subscription,
        mode,
        selectedModelOverride: selected,
      });
      expect(assignment !== undefined).toBe(eligible);
      // Ineligible requests never ask PostHog for an assignment.
      expect(posthog.getFeatureFlagResult).toHaveBeenCalledTimes(
        eligible ? 1 : 0,
      );
      expect(getPaidAgentContextSelection(subscription, mode, selected)).toBe(
        eligible ? (selected ?? "auto") : undefined,
      );
      if (assignment)
        expect(assignment.requestedSelection).toBe(selected ?? "auto");
    },
  );
});

describe("paid Agent context assignment", () => {
  it.each(["control", "test"] as const)(
    "assigns %s by user id without recording exposure",
    async (variant) => {
      const posthog = flagClient({ enabled: true, variant });
      expect(await resolve(posthog, { subscription: "team" })).toEqual({
        flagKey: PAID_AGENT_CONTEXT_FLAG,
        variant,
        requestedSelection: "auto",
      });
      expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
        "paid_agent_context_480k_v1",
        "user-1",
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription: "team", subscription_tier: "team" },
        },
      );
    },
  );

  it.each([
    ["missing", undefined],
    ["disabled", { enabled: false, variant: "test" }],
    ["boolean", { enabled: true }],
    ["unknown variant", { enabled: true, variant: "treatment" }],
  ])("keeps the baseline for a %s flag", async (_label, result) => {
    expect(await resolve(flagClient(result))).toBeUndefined();
  });

  it("keeps the baseline when evaluation fails or PostHog is unavailable", async () => {
    const failing = {
      getFeatureFlagResult: jest.fn(async () => {
        throw new Error("flags unavailable");
      }),
    };
    expect(await resolve(failing)).toBeUndefined();
    expect(await resolve(null)).toBeUndefined();
    expect(
      await resolve(flagClient(TEST_FLAG), { userId: "" }),
    ).toBeUndefined();
  });
});

describe("agent context policy", () => {
  it.each(PAID)("selects the run policy for %s", (subscription) => {
    const test = { variant: "test" as const };
    const control = { variant: "control" as const };
    const policy = (
      selectedModelOverride: SelectedModel | undefined,
      paidAgentContext?: { variant: "control" | "test" },
      mode: ChatMode = "agent",
    ) =>
      getAgentContextPolicy({
        subscription,
        mode,
        selectedModelOverride,
        paidAgentContext,
      });
    for (const selected of [undefined, "auto", "hackerai-standard"] as const) {
      expect(policy(selected, test)).toBe("paid_480k");
      expect(policy(selected, control)).toBe("baseline");
      expect(policy(selected)).toBe("baseline");
      expect(policy(selected, test, "ask")).toBe("baseline");
    }
    // Explicit Pro/Max keep their permanent policy regardless of a snapshot.
    for (const selected of ["hackerai-pro", "hackerai-max"] as const) {
      expect(policy(selected, test)).toBe("expanded");
      expect(policy(selected, control)).toBe("expanded");
      expect(policy(selected, test, "ask")).toBe("baseline");
    }
  });

  it("never applies a leaked treatment snapshot to Free", () => {
    for (const selected of SELECTIONS)
      expect(
        getAgentContextPolicy({
          subscription: "free",
          mode: "agent",
          selectedModelOverride: selected,
          paidAgentContext: { variant: "test" },
        }),
      ).toBe("baseline");
  });
});

describe("paid Agent context analytics", () => {
  it("separates assignment from exposure and reports only closed fields", () => {
    const assignment = {
      flagKey: PAID_AGENT_CONTEXT_FLAG,
      variant: "test" as const,
      requestedSelection: "hackerai-standard" as const,
    };
    expect(paidAgentContextAnalyticsProperties(undefined)).toEqual({});
    expect(paidAgentContextAnalyticsProperties(assignment)).toEqual({
      "$feature/paid_agent_context_480k_v1": "test",
      paid_agent_context_variant: "test",
      paid_agent_context_selection: "hackerai-standard",
      paid_agent_context_exposed: false,
    });
    expect(
      paidAgentContextAnalyticsProperties({
        ...assignment,
        exposure: {
          modelId: "x-ai/grok-4.5",
          contextMaxTokens: 468_000,
          compactionThresholdTokens: 448_000,
          routeSupports480k: false,
        },
      }),
    ).toEqual({
      "$feature/paid_agent_context_480k_v1": "test",
      paid_agent_context_variant: "test",
      paid_agent_context_selection: "hackerai-standard",
      paid_agent_context_exposed: true,
      paid_agent_context_max_tokens: 468_000,
      paid_agent_context_threshold_tokens: 448_000,
      paid_agent_context_480k_active: false,
      paid_agent_context_route_supports_480k: false,
    });
  });
});
