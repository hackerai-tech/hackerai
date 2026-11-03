import { DEEPSEEK_1017_MODEL_KEY } from "../paid-deepseek-1017";
import { myProvider } from "@/lib/ai/providers";
import { buildProviderOptions } from "@/lib/api/chat-stream-helpers";
import { calculateTokenCost } from "@/lib/rate-limit/token-bucket";
import {
  evaluatePaidAgentAccuracy,
  createPaidAgentAccuracyExposureRecorder,
  PAID_AGENT_ACCURACY_KEY,
  PAID_AGENT_ACCURACY_MODEL,
  PAID_AGENT_ACCURACY_EXPOSED,
} from "../paid-agent-accuracy";

const eligible = {
  userId: "synthetic-user",
  mode: "agent" as const,
  subscription: "pro" as const,
  selectedModel: DEEPSEEK_1017_MODEL_KEY,
  selectedModelOverride: "auto" as const,
  hasAttachments: false,
};
const flags = (value: unknown) => ({
  evaluateFlags: jest.fn(async () => ({ getFlag: () => value })),
});

it("uses the candidate's real provider configuration and higher model cost", async () => {
  const model = await evaluatePaidAgentAccuracy({
    ...eligible,
    posthog: flags(true) as never,
  });
  expect(model).toBe(PAID_AGENT_ACCURACY_MODEL);
  expect(myProvider.languageModel(model!).modelId).toBe("x-ai/grok-4.6");
  const options = buildProviderOptions(true, eligible.userId, model!, "agent", {
    selectedModelOverride: "hackerai-standard",
  });
  expect(options.openrouter.reasoning).toEqual({
    enabled: true,
    effort: "high",
  });
  expect(calculateTokenCost(20_000, "input", model!)).toBeGreaterThan(
    calculateTokenCost(20_000, "input", DEEPSEEK_1017_MODEL_KEY),
  );
});

it.each(["auto", "hackerai-standard", "hackerai-pro"] as const)(
  "routes enabled paid %s requests before admission",
  async (selectedModelOverride) => {
    const posthog = flags(true);
    expect(
      await evaluatePaidAgentAccuracy({
        ...eligible,
        selectedModelOverride,
        posthog: posthog as never,
      }),
    ).toBe(PAID_AGENT_ACCURACY_MODEL);
    expect(posthog.evaluateFlags).toHaveBeenCalledWith(eligible.userId, {
      flagKeys: [PAID_AGENT_ACCURACY_KEY],
    });
  },
);

it.each([
  { subscription: "free" as const },
  { mode: "ask" as const },
  { selectedModelOverride: "hackerai-max" as const },
  { selectedModel: "model-glm-5.3" as const },
  { hasAttachments: true },
  { limitRescue: true },
  { modelPolicyActive: true },
  { userId: "" },
])(
  "preserves excluded routes without flag evaluation: %s",
  async (override) => {
    const posthog = flags(true);
    expect(
      await evaluatePaidAgentAccuracy({
        ...eligible,
        ...override,
        posthog: posthog as never,
      }),
    ).toBeUndefined();
    expect(posthog.evaluateFlags).not.toHaveBeenCalled();
  },
);

it.each([false, undefined, "true", "test"])(
  "retains baseline for disabled or malformed allocation %s",
  async (value) => {
    expect(
      await evaluatePaidAgentAccuracy({
        ...eligible,
        posthog: flags(value) as never,
      }),
    ).toBeUndefined();
  },
);

it("retains baseline when analytics is absent or unavailable", async () => {
  expect(
    await evaluatePaidAgentAccuracy({ ...eligible, posthog: null }),
  ).toBeUndefined();
  expect(
    await evaluatePaidAgentAccuracy({
      ...eligible,
      posthog: {
        evaluateFlags: async () => {
          throw Error("unavailable");
        },
      } as never,
    }),
  ).toBeUndefined();
});

it("records actual candidate dispatch once and excludes requests rerouted by rescue", () => {
  const posthog = { capture: jest.fn() };
  const args = {
    posthog,
    enabled: true,
    selectedModel: PAID_AGENT_ACCURACY_MODEL,
    userId: eligible.userId,
    subscription: eligible.subscription,
    selectedModelOverride: eligible.selectedModelOverride,
    requestId: "one-request",
  };
  const record = createPaidAgentAccuracyExposureRecorder(args);
  expect(posthog.capture).not.toHaveBeenCalled();
  record("deepseek/deepseek-v4.1-flash-1017");
  expect(posthog.capture).not.toHaveBeenCalled();
  record("x-ai/grok-4.6");
  record("x-ai/grok-4.6");
  expect(posthog.capture).toHaveBeenCalledTimes(1);
  expect(posthog.capture).toHaveBeenCalledWith({
    distinctId: eligible.userId,
    event: PAID_AGENT_ACCURACY_EXPOSED,
    properties: expect.objectContaining({
      flag_key: PAID_AGENT_ACCURACY_KEY,
      flag_enabled: true,
      request_id: "one-request",
      configured_model: "x-ai/grok-4.6",
      exposure_surface: "provider_request",
    }),
  });
  posthog.capture.mockClear();
  createPaidAgentAccuracyExposureRecorder({
    ...args,
    selectedModel: DEEPSEEK_1017_MODEL_KEY,
  })("x-ai/grok-4.6");
  createPaidAgentAccuracyExposureRecorder({ ...args, enabled: false })(
    "x-ai/grok-4.6",
  );
  expect(posthog.capture).not.toHaveBeenCalled();
});

it("does not interrupt generation when exposure reporting fails", () => {
  const record = createPaidAgentAccuracyExposureRecorder({
    posthog: {
      capture: () => {
        throw Error("unavailable");
      },
    },
    enabled: true,
    selectedModel: PAID_AGENT_ACCURACY_MODEL,
    userId: eligible.userId,
    subscription: eligible.subscription,
    requestId: "reporting-failure",
  });
  expect(() => record("x-ai/grok-4.6")).not.toThrow();
});
