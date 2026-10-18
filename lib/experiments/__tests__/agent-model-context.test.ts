import {
  isAgentModelContextEnabled,
  AGENT_MODEL_CONTEXT_FLAG,
} from "../agent-model-context";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
}));
const decision = jest.mocked(getPostHogBooleanFlagDecisionForUser);

beforeEach(() => jest.clearAllMocks());

it("does not evaluate or expose the flag for Ask", async () => {
  decision.mockResolvedValue(true);
  expect(await isAgentModelContextEnabled("user", "pro", "ask")).toBe(false);
  expect(decision).not.toHaveBeenCalled();
});

it.each([true, false, null])(
  "only enables Agent for an explicit true decision (%s)",
  async (value) => {
    decision.mockResolvedValue(value);
    expect(await isAgentModelContextEnabled("user", "pro", "agent")).toBe(
      value === true,
    );
    expect(decision).toHaveBeenCalledWith(
      AGENT_MODEL_CONTEXT_FLAG,
      "user",
      { subscription_tier: "pro", mode: "agent" },
      { sendFeatureFlagEvents: false },
    );
  },
);
