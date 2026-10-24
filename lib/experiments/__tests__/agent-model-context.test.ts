import {
  isAgentModelContextEnabled,
  getAgentModelContextVariant,
  AGENT_MODEL_CONTEXT_FLAG,
  PRO_AGENT_MODEL_CONTEXT_FLAG,
} from "../agent-model-context";
import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagVariantForUser: jest.fn(),
}));
const decision = jest.mocked(getPostHogFeatureFlagVariantForUser);

beforeEach(() => jest.clearAllMocks());

it.each(["hackerai-max", "hackerai-pro"] as const)(
  "does not evaluate or expose $model for Ask",
  async (model) => {
    decision.mockResolvedValue("test");
    expect(await isAgentModelContextEnabled("user", "pro", "ask", model)).toBe(
      false,
    );
    expect(decision).not.toHaveBeenCalled();
  },
);

it.each(
  (["hackerai-max", "hackerai-pro"] as const).flatMap((model) =>
    ["test", "control", false, undefined, "unknown"].map((value) => ({
      model,
      value,
    })),
  ),
)(
  "only enables $model for its own explicit test decision ($value)",
  async ({ model, value }) => {
    decision.mockResolvedValue(value);
    expect(
      await isAgentModelContextEnabled("user", "pro", "agent", model),
    ).toBe(value === "test");
    expect(
      await getAgentModelContextVariant("user", "pro", "agent", model),
    ).toBe(value === "control" || value === "test" ? value : undefined);
    expect(decision).toHaveBeenCalledWith(
      model === "hackerai-max"
        ? AGENT_MODEL_CONTEXT_FLAG
        : PRO_AGENT_MODEL_CONTEXT_FLAG,
      "user",
      {
        personProperties: {
          subscription_tier: "pro",
          mode: "agent",
          selected_model: model,
        },
        sendFeatureFlagEvents: false,
      },
    );
  },
);

it.each([undefined, "auto", "hackerai-standard"] as const)(
  "does not enable larger context for %s",
  async (model) => {
    decision.mockResolvedValue("test");
    expect(
      await isAgentModelContextEnabled("user", "pro", "agent", model),
    ).toBe(false);
    expect(decision).not.toHaveBeenCalled();
  },
);

it.each(["ask", "agent"] as const)(
  "never expands Free Pro requests in %s",
  async (mode) => {
    decision.mockResolvedValue("test");
    expect(
      await isAgentModelContextEnabled("user", "free", mode, "hackerai-pro"),
    ).toBe(false);
    expect(decision).not.toHaveBeenCalled();
  },
);
