import {
  isAgentModelContextEnabled,
  getAgentModelContextVariant,
  AGENT_MODEL_CONTEXT_FLAG,
} from "../agent-model-context";
import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagVariantForUser: jest.fn(),
}));
const decision = jest.mocked(getPostHogFeatureFlagVariantForUser);

beforeEach(() => jest.clearAllMocks());

it("does not evaluate or expose the flag for Ask", async () => {
  decision.mockResolvedValue("test");
  expect(
    await isAgentModelContextEnabled("user", "pro", "ask", "hackerai-max"),
  ).toBe(false);
  expect(decision).not.toHaveBeenCalled();
});

it.each(["test", "control", undefined, "unknown"])(
  "only enables Agent for an explicit test decision (%s)",
  async (value) => {
    decision.mockResolvedValue(value);
    expect(
      await isAgentModelContextEnabled("user", "pro", "agent", "hackerai-max"),
    ).toBe(value === "test");
    expect(
      await getAgentModelContextVariant("user", "pro", "agent", "hackerai-max"),
    ).toBe(value === "control" || value === "test" ? value : undefined);
    expect(decision).toHaveBeenCalledWith(AGENT_MODEL_CONTEXT_FLAG, "user", {
      personProperties: {
        subscription_tier: "pro",
        mode: "agent",
        selected_model: "hackerai-max",
      },
      sendFeatureFlagEvents: false,
    });
  },
);

it.each([undefined, "auto", "hackerai-standard", "hackerai-pro"] as const)(
  "does not enable larger context for %s",
  async (model) => {
    decision.mockResolvedValue("test");
    expect(
      await isAgentModelContextEnabled("user", "pro", "agent", model),
    ).toBe(false);
    expect(decision).not.toHaveBeenCalled();
  },
);
