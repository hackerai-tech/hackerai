/** @jest-environment node */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const decision = jest.fn<any>();
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: (...args: unknown[]) =>
    decision(...args),
}));

// Import after the mock is registered; @jest/globals mocks are not hoisted
// above static imports.
const policy = () => import("../http-retest-policy");
const isHttpFindingRetestsEnabled = async (userId: string) =>
  (await policy()).isHttpFindingRetestsEnabled(userId);
const HTTP_FINDING_RETESTS_FLAG = "http_finding_retests_v1";

describe("http_finding_retests_v1 gate", () => {
  afterEach(() => {
    jest.useRealTimers();
    decision.mockReset();
  });

  it("enables only on an explicit true assignment, without exposure events", async () => {
    decision.mockResolvedValue(true);
    expect(await isHttpFindingRetestsEnabled("user-1")).toBe(true);
    expect(decision).toHaveBeenCalledWith(
      HTTP_FINDING_RETESTS_FLAG,
      "user-1",
      undefined,
      { sendFeatureFlagEvents: false },
    );
  });

  it.each([
    ["false", () => Promise.resolve(false)],
    ["unavailable", () => Promise.resolve(null)],
    ["an evaluation error", () => Promise.reject(new Error("posthog down"))],
  ])("fails closed when the decision is %s", async (_name, value) => {
    decision.mockImplementation(value);
    expect(await isHttpFindingRetestsEnabled("user-1")).toBe(false);
  });

  it("fails closed when evaluation is slow", async () => {
    jest.useFakeTimers();
    decision.mockReturnValue(new Promise(() => {}));
    const pending = isHttpFindingRetestsEnabled("user-1");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe(false);
  });
});
