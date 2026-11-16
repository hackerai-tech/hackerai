import {
  getAgentContextBudget,
  getAgentHistoryBudget,
} from "../agent-context-budget";
import { MAX_OUTPUT_TOKENS } from "../output-limits";
import { getMaxFileTokens } from "@/lib/token-limits";
import { getSummarizationThresholdTokens } from "@/lib/chat/summarization/constants";
import { myProvider } from "@/lib/ai/providers";
import { getFallbackSlugs } from "@/lib/api/chat-stream-helpers";
import { getNextProviderDisconnectRetryModel } from "@/lib/chat/agent-long-provider-retry";
import { selectModel } from "@/lib/chat/chat-processor";
import type { SelectedModel } from "@/types";

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const route = {
  enabled: true,
  mode: "agent" as const,
  subscription: "pro" as const,
  modelId: "z-ai/glm-5.3-flash",
};

it("allows a long Agent prompt while reserving output and compaction headroom", () => {
  const budget = getAgentContextBudget(route);
  expect(budget).toBe(508_288);
  expect(getSummarizationThresholdTokens(budget)).toBe(488_288);
  expect(getSummarizationThresholdTokens(budget)).toBeGreaterThan(300_000);
});

it("bounds the whole transparent fallback route by its smallest member", () => {
  const budget = getAgentContextBudget({
    ...route,
    fallbackModelIds: ["moonshotai/kimi-k3", "x-ai/grok-4.6"],
  });
  expect(budget).toBe(234_000);
  expect(getSummarizationThresholdTokens(budget)).toBe(214_000);
  expect(
    getAgentContextBudget({
      ...route,
      fallbackModelIds: ["deepseek/deepseek-v4-pro-0813"],
    }),
  ).toBe(496_000);
});

it.each([
  { enabled: false },
  { enabled: undefined },
  { modelId: "custom/unknown" },
  { modelId: "constructor" },
  { modelId: "__proto__" },
  { modelId: "abliterated-model" },
  { fallbackModelIds: ["custom/unknown"] },
  { fallbackModelIds: ["abliterated-model"] },
])("uses the 276k baseline when expansion is unavailable: %j", (override) => {
  expect(getAgentContextBudget({ ...route, ...override })).toBe(276_000);
});

it.each(["free", "pro"] as const)(
  "leaves %s Ask and upload budgets unchanged even with the flag enabled",
  (subscription) => {
    const baseline = 276_000;
    for (const policy of ["expanded", "paid_480k"] as const) {
      expect(
        getAgentContextBudget({ ...route, policy, subscription, mode: "ask" }),
      ).toBe(baseline);
      expect(getAgentHistoryBudget(subscription, "ask", policy)).toBe(baseline);
    }
    expect(getMaxFileTokens(subscription, { mode: "ask" })).toBe(baseline / 2);
  },
);

it("uses the exact 1M Large v2 capacity rather than the base model limit", () => {
  const budget = getAgentContextBudget({
    ...route,
    modelId: "abliterated-model-large-v2",
  });
  expect(budget).toBe(484_000);
  expect(getSummarizationThresholdTokens(budget)).toBe(464_000);
});

it("uses Flash's verified capacity only when context expansion is enabled", () => {
  const flash = { ...route, modelId: "abliterated-model-large-flash" };
  expect(getAgentContextBudget(flash)).toBe(508_288);
  expect(getAgentContextBudget({ ...flash, enabled: false })).toBe(276_000);
  expect(getAgentContextBudget({ ...flash, mode: "ask" })).toBe(276_000);
});

it.each(["free", "pro", "pro-plus", "ultra", "team"] as const)(
  "loads the %s baseline history and reserves 20k tokens before compaction",
  (subscription) => {
    const budget = getAgentHistoryBudget(subscription, "agent");
    expect(budget).toBe(276_000);
    expect(getSummarizationThresholdTokens(budget)).toBe(256_000);
  },
);

describe("paid 480K treatment budget", () => {
  const treatment = {
    policy: "paid_480k" as const,
    mode: "agent" as const,
    subscription: "pro" as const,
  };

  it("triggers compaction at exactly 480K, not the half-window 476K", () => {
    const budget = getAgentContextBudget({
      ...treatment,
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      fallbackModelIds: [
        "z-ai/glm-5.3-flash",
        "deepseek/deepseek-v4-pro-0813",
        "z-ai/glm-5.3",
      ],
    });
    expect(budget).toBe(500_000);
    expect(getSummarizationThresholdTokens(budget)).toBe(480_000);
    // Same route under the explicit Pro half-window policy.
    expect(
      getAgentContextBudget({
        ...treatment,
        policy: "expanded",
        modelId: "deepseek/deepseek-v4.1-flash-1017",
        fallbackModelIds: ["deepseek/deepseek-v4-pro-0813"],
      }),
    ).toBe(496_000);
  });

  it("caps at the smallest verified member minus the 32K output reserve", () => {
    const budget = getAgentContextBudget({
      ...treatment,
      modelId: "x-ai/grok-4.5",
      fallbackModelIds: ["moonshotai/kimi-k3"],
    });
    expect(budget).toBe(500_000 - MAX_OUTPUT_TOKENS);
    expect(getSummarizationThresholdTokens(budget)).toBe(448_000);
  });

  it.each([
    { modelId: "custom/unknown" },
    { modelId: "__proto__" },
    { fallbackModelIds: ["custom/unknown"] },
    { subscription: "free" as const },
    { subscription: undefined },
    { mode: "ask" as const },
  ])("fails closed to the 276K baseline: %j", (override) => {
    expect(
      getAgentContextBudget({
        ...treatment,
        modelId: "z-ai/glm-5.3",
        ...override,
      }),
    ).toBe(276_000);
  });

  it("loads treatment history to the target and never raises Free", () => {
    expect(getAgentHistoryBudget("pro", "agent", "paid_480k")).toBe(500_000);
    expect(getAgentHistoryBudget("team", "agent", "paid_480k")).toBe(500_000);
    expect(getAgentHistoryBudget("free", "agent", "paid_480k")).toBe(
      getAgentHistoryBudget("free", "agent"),
    );
    expect(getAgentHistoryBudget("pro", "agent", "expanded")).toBe(508_288);
  });
});

describe("paid 480K treatment on real Auto and Standard routes", () => {
  const routeBudget = (modelName: string, selected?: SelectedModel) => {
    const modelId = myProvider.languageModel(modelName).modelId;
    const fallbackModelIds = getFallbackSlugs(modelName, "agent", {
      selectedModelOverride: selected,
    });
    return {
      fallbackModelIds,
      budget: getAgentContextBudget({
        policy: "paid_480k",
        mode: "agent",
        subscription: "pro",
        modelId,
        fallbackModelIds,
      }),
      members: [modelId, ...fallbackModelIds],
    };
  };
  // Every member alone must also admit the budget plus the output reserve, or
  // a transparent fallback could receive a request it cannot hold.
  const expectEveryMemberFits = (members: string[], budget: number) => {
    for (const member of members)
      expect(
        getAgentContextBudget({
          policy: "paid_480k",
          mode: "agent",
          subscription: "pro",
          modelId: member,
        }),
      ).toBeGreaterThanOrEqual(budget);
  };

  it.each([
    [undefined, "pro"],
    ["auto", "ultra"],
    ["hackerai-standard", "team"],
    ["hackerai-standard", "pro-plus"],
  ] as const)(
    "reaches the exact 480K trigger for %s text on %s",
    (selected, subscription) => {
      const modelName = selectModel("agent", subscription, selected);
      const { budget, members, fallbackModelIds } = routeBudget(
        modelName,
        selected,
      );
      expect(fallbackModelIds.length).toBeGreaterThan(0);
      expect(budget).toBe(500_000);
      expect(getSummarizationThresholdTokens(budget)).toBe(480_000);
      expectEveryMemberFits(members, budget);
    },
  );

  it("stays under capacity on the paid Auto Grok image route", () => {
    const modelName = selectModel("agent", "ultra", "auto", true);
    const { budget, members } = routeBudget(modelName, "auto");
    expect(budget).toBeLessThan(500_000);
    expect(budget).toBeGreaterThan(276_000);
    expectEveryMemberFits(members, budget);
  });

  it("keeps every DeepSeek Pro disconnect recovery model within capacity", () => {
    const original = "model-deepseek-v4-pro-0813";
    const first = getNextProviderDisconnectRetryModel({
      originalModel: original,
      failedModel: original,
      completedRetryCount: 0,
    });
    const second = getNextProviderDisconnectRetryModel({
      originalModel: original,
      failedModel: first!,
      completedRetryCount: 1,
    });
    for (const modelName of [original, first!, second!]) {
      const { budget, members } = routeBudget(modelName, "auto");
      expect(budget).toBeGreaterThan(276_000);
      expectEveryMemberFits(members, budget);
    }
  });
});
