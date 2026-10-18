import {
  getAgentContextBudget,
  getAgentHistoryBudget,
} from "../agent-context-budget";
import { getMaxFileTokens } from "@/lib/token-limits";
import { getSummarizationThresholdTokens } from "@/lib/chat/summarization/constants";

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
  { fallbackModelIds: ["custom/unknown"] },
])(
  "retains the legacy budget when expansion is unavailable: %j",
  (override) => {
    expect(getAgentContextBudget({ ...route, ...override })).toBe(200_000);
  },
);

it.each(["free", "pro"] as const)(
  "leaves %s Ask and upload budgets unchanged even with the flag enabled",
  (subscription) => {
    const baseline = subscription === "free" ? 128_000 : 200_000;
    expect(getAgentContextBudget({ ...route, subscription, mode: "ask" })).toBe(
      baseline,
    );
    expect(getAgentHistoryBudget(subscription, "ask", true)).toBe(baseline);
    expect(getMaxFileTokens(subscription, { mode: "ask" })).toBe(baseline / 2);
  },
);
