/** @jest-environment node */
const mockDecision = jest.fn();
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: (...args: unknown[]) =>
    mockDecision(...args),
}));

import { FINDING_HUNTS_FLAG, isFindingHuntsEnabled } from "../hunt-policy";

describe("finding hunt rollout", () => {
  beforeEach(() => {
    jest.useRealTimers();
    mockDecision.mockReset();
  });

  it("enables only on an explicit true assignment without exposure events", async () => {
    mockDecision.mockResolvedValue(true);
    expect(await isFindingHuntsEnabled("user-1")).toBe(true);
    expect(mockDecision).toHaveBeenCalledWith(
      FINDING_HUNTS_FLAG,
      "user-1",
      undefined,
      { sendFeatureFlagEvents: false },
    );
    mockDecision.mockResolvedValue("variant");
    expect(await isFindingHuntsEnabled("user-1")).toBe(false);
  });

  it("fails closed on errors", async () => {
    mockDecision.mockRejectedValue(new Error("down"));
    expect(await isFindingHuntsEnabled("user-1")).toBe(false);
  });

  it("fails closed when evaluation is slow", async () => {
    jest.useFakeTimers();
    mockDecision.mockReturnValue(new Promise(() => {}));
    const decision = isFindingHuntsEnabled("user-1");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await decision).toBe(false);
  });
});
