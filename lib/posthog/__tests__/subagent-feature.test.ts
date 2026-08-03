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

  it("keeps preview deployments behind the PostHog flag", async () => {
    const environment = {
      NODE_ENV: "development",
      VERCEL_ENV: "preview",
    };
    mockGetPostHogFeatureFlagForUser.mockResolvedValueOnce(true);

    expect(shouldBypassSecurityValidationSubagentsFlag(environment)).toBe(
      false,
    );
    await expect(
      resolveSecurityValidationSubagentsEnabled("user_123", environment),
    ).resolves.toBe(true);
    expect(mockGetPostHogFeatureFlagForUser).toHaveBeenCalledWith(
      SECURITY_VALIDATION_SUBAGENTS_FLAG,
      "user_123",
    );
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
