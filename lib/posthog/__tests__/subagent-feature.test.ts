import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetPostHogFeatureFlagForUser = jest.fn();

jest.mock("server-only", () => ({}));

jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagForUser: mockGetPostHogFeatureFlagForUser,
}));

const {
  SECURITY_VALIDATION_SUBAGENTS_FLAG,
  resolveSecurityValidationSubagentsEnabled,
  shouldBypassSecurityValidationSubagentsFlag,
} = require("../subagent-feature") as typeof import("../subagent-feature");

describe("security validation subagent feature", () => {
  beforeEach(() => {
    mockGetPostHogFeatureFlagForUser.mockReset();
  });

  it("enables local development without evaluating PostHog", async () => {
    const environment = { NODE_ENV: "development" };

    expect(shouldBypassSecurityValidationSubagentsFlag(environment)).toBe(true);
    await expect(
      resolveSecurityValidationSubagentsEnabled("user_123", environment),
    ).resolves.toBe(true);
    expect(mockGetPostHogFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("enables preview deployments without evaluating PostHog", async () => {
    const environment = {
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
    };

    expect(shouldBypassSecurityValidationSubagentsFlag(environment)).toBe(true);
    await expect(
      resolveSecurityValidationSubagentsEnabled("user_123", environment),
    ).resolves.toBe(true);
    expect(mockGetPostHogFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("keeps production behind the PostHog flag and fails closed", async () => {
    const environment = {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
    };
    mockGetPostHogFeatureFlagForUser.mockResolvedValueOnce(false);

    expect(shouldBypassSecurityValidationSubagentsFlag(environment)).toBe(
      false,
    );
    await expect(
      resolveSecurityValidationSubagentsEnabled("user_123", environment),
    ).resolves.toBe(false);
  });
});
