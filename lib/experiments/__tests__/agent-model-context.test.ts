import { isExpandedAgentContextEligible } from "../agent-model-context";
import type { SubscriptionTier } from "@/types";

const paidTiers = ["pro", "pro-plus", "ultra", "team"] as const;
const expandedModels = ["hackerai-max", "hackerai-pro"] as const;

it.each(
  paidTiers.flatMap((subscription) =>
    expandedModels.map((model) => ({ subscription, model })),
  ),
)(
  "enables paid $subscription Agent requests for explicit $model",
  ({ subscription, model }) => {
    expect(isExpandedAgentContextEligible(subscription, "agent", model)).toBe(
      true,
    );
  },
);

it.each(
  paidTiers.flatMap((subscription) =>
    expandedModels.map((model) => ({ subscription, model })),
  ),
)(
  "keeps Ask context unchanged for $subscription / $model",
  ({ subscription, model }) => {
    expect(isExpandedAgentContextEligible(subscription, "ask", model)).toBe(
      false,
    );
  },
);

it.each(expandedModels)("keeps Free context unchanged for %s", (model) => {
  expect(isExpandedAgentContextEligible("free", "agent", model)).toBe(false);
});

it.each(
  paidTiers.flatMap((subscription) =>
    [undefined, "auto", "hackerai-standard"].map((model) => ({
      subscription,
      model,
    })),
  ),
)(
  "does not expand $subscription context for $model",
  ({ subscription, model }) => {
    expect(isExpandedAgentContextEligible(subscription, "agent", model)).toBe(
      false,
    );
  },
);

it("does not silently enroll an unknown future subscription", () => {
  expect(
    isExpandedAgentContextEligible(
      "unknown" as SubscriptionTier,
      "agent",
      "hackerai-pro",
    ),
  ).toBe(false);
});
