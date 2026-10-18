import {
  evaluateFlashRouting,
  createFlashRoutingExposureRecorder,
  getActiveFlashRoutingAssignment,
} from "../flash-routing";
import { FREE_AGENT_DEEPSEEK_1017_KEY } from "../free-agent-deepseek-1017";
import {
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "../paid-deepseek-1017";
import { buildProviderOptions } from "@/lib/api/chat-stream-helpers";
import {
  resolveAgentModelAfterSummarization,
  resolveAgentModelForImageToolResults,
} from "@/lib/api/agent-stream-runner";

const freeAgent = {
  userId: "free-user",
  subscription: "free" as const,
  mode: "agent" as const,
  selectedModel: "model-glm-5.3-flash-agent",
  hasImages: false,
};
const client = (variant: unknown) => ({
  getFeatureFlagResult: jest.fn().mockResolvedValue({ enabled: true, variant }),
  evaluateFlags: jest.fn(),
  capture: jest.fn(),
});

it.each([
  ["control", "model-glm-5.3-flash-agent", "z-ai/glm-5.3-flash"],
  ["test", DEEPSEEK_1017_MODEL_KEY, DEEPSEEK_1017_SLUG],
] as const)(
  "serves the assigned Free Agent %s without early exposure",
  async (variant, modelKey, slug) => {
    const posthog = client(variant);
    const assignment = await evaluateFlashRouting({
      ...freeAgent,
      posthog: posthog as never,
    });
    expect(assignment).toMatchObject({
      key: FREE_AGENT_DEEPSEEK_1017_KEY,
      variant,
      modelKey,
      configuredModel: slug,
      baselineModel: freeAgent.selectedModel,
    });
    expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
      FREE_AGENT_DEEPSEEK_1017_KEY,
      "free-user",
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription_tier: "free" },
      },
    );
    expect(posthog.capture).not.toHaveBeenCalled();
    const record = createFlashRoutingExposureRecorder({
      ...freeAgent,
      posthog: posthog as never,
      assignment,
      requestId: "original-request",
    });
    record("unrelated-provider-model");
    expect(posthog.capture).not.toHaveBeenCalled();
    record(slug);
    record(slug);
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "flash_routing_experiment_exposed",
        distinctId: "free-user",
        properties: expect.objectContaining({
          experiment_key: FREE_AGENT_DEEPSEEK_1017_KEY,
          experiment_request_id: "original-request",
          experiment_variant: variant,
          subscription_tier: "free",
        }),
      }),
    );
    expect(
      getActiveFlashRoutingAssignment(assignment, modelKey, true),
    ).toBeUndefined();
    expect(
      getActiveFlashRoutingAssignment(assignment, "model-glm-5.3", false),
    ).toBeUndefined();
  },
);

it.each([
  { mode: "ask" as const },
  { subscription: "pro" as const },
  { subscription: "pro-plus" as const },
  { subscription: "ultra" as const },
  { subscription: "team" as const },
  { selectedModel: "ask-model-free-glm" },
  { selectedModel: "model-glm-5.3-flash" },
  { hasImages: true },
  { limitRescue: true },
  { modelPolicyActive: true },
  { userId: "" },
])(
  "preserves routes outside the Free Agent baseline: %j",
  async (overrides) => {
    const posthog = client("test");
    expect(
      await evaluateFlashRouting({
        ...freeAgent,
        ...overrides,
        posthog: posthog as never,
      }),
    ).toBeUndefined();
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
  },
);

it.each([undefined, false, true, "unknown"])(
  "keeps GLM for invalid flag %s",
  async (variant) => {
    expect(
      await evaluateFlashRouting({
        ...freeAgent,
        posthog: client(variant) as never,
      }),
    ).toBeUndefined();
  },
);

it("keeps GLM when flag evaluation fails or the flag is disabled", async () => {
  const posthog = client("test");
  posthog.getFeatureFlagResult.mockRejectedValueOnce(new Error("unavailable"));
  expect(
    await evaluateFlashRouting({ ...freeAgent, posthog: posthog as never }),
  ).toBeUndefined();
  posthog.getFeatureFlagResult.mockResolvedValueOnce({
    enabled: false,
    variant: "test",
  });
  expect(
    await evaluateFlashRouting({ ...freeAgent, posthog: posthog as never }),
  ).toBeUndefined();
});

it("preserves GLM reasoning defaults and holds 1017 high across compaction and image tool results", () => {
  expect(
    buildProviderOptions(true, "free-user", freeAgent.selectedModel, "agent")
      .openrouter,
  ).not.toHaveProperty("reasoning");
  expect(
    buildProviderOptions(true, "free-user", DEEPSEEK_1017_MODEL_KEY, "agent", {
      reasoningOverride: { enabled: false },
    }).openrouter.reasoning,
  ).toEqual({ enabled: true, effort: "high" });
  for (const model of [freeAgent.selectedModel, DEEPSEEK_1017_MODEL_KEY]) {
    expect(resolveAgentModelAfterSummarization(model, "agent", false)).toBe(
      model,
    );
    expect(
      resolveAgentModelForImageToolResults(
        model,
        "agent",
        true,
        "auto",
        false,
        true,
        "free",
      ),
    ).toBe(model);
  }
});
