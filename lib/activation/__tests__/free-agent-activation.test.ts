import {
  createFreeAgentActivationStatus,
  isFreeAgentActivationRequiredMetadata,
} from "../free-agent-activation";

describe("free Agent activation status contract", () => {
  it.each([
    ["test", 2, 2, false],
    ["test", 3, 3, true],
    ["test", 7, 3, true],
    ["test", -1, 0, false],
    ["control", 3, 3, false],
  ] as const)(
    "%s with %d stored responses reports %d and requiresAgent=%s",
    (variant, stored, completed, requiresAgent) => {
      expect(createFreeAgentActivationStatus(variant, stored)).toEqual({
        variant,
        completedAskResponses: completed,
        introLimit: 3,
        requiresAgent,
      });
    },
  );

  it("recognizes only the explicit Ask denial metadata", () => {
    expect(
      isFreeAgentActivationRequiredMetadata({
        free_agent_activation_required: true,
      }),
    ).toBe(true);
    for (const metadata of [
      undefined,
      null,
      "free_agent_activation_required",
      { free_agent_activation_required: "true" },
      { subscription_required: true },
    ]) {
      expect(isFreeAgentActivationRequiredMetadata(metadata)).toBe(false);
    }
  });
});
