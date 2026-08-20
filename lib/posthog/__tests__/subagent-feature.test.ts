import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetPostHogFeatureFlagForUser = jest.fn();

jest.mock("server-only", () => ({}));

jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagForUser: mockGetPostHogFeatureFlagForUser,
}));

const { SECURITY_TASK_SUBAGENTS_FLAG, resolveSecurityTaskSubagentsEnabled } =
  require("../subagent-feature") as typeof import("../subagent-feature");

describe("security task subagent feature", () => {
  beforeEach(() => {
    mockGetPostHogFeatureFlagForUser.mockReset();
  });

  it("evaluates the generic task flag in every environment", async () => {
    mockGetPostHogFeatureFlagForUser.mockResolvedValueOnce(true);

    await expect(resolveSecurityTaskSubagentsEnabled("user_123")).resolves.toBe(
      true,
    );
    expect(mockGetPostHogFeatureFlagForUser).toHaveBeenCalledWith(
      SECURITY_TASK_SUBAGENTS_FLAG,
      "user_123",
    );
  });
});
