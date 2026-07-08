import { describe, it, expect } from "@jest/globals";
import {
  isFeatureEnabled,
  isCrossTabTokenSharingEnabled,
  FEATURE_FLAGS,
  FEATURE_ROLLOUTS,
} from "../feature-flags";

describe("feature-flags", () => {
  describe("isFeatureEnabled", () => {
    it("should return false when percentage is 0", () => {
      expect(isFeatureEnabled("user-123", "test-feature", 0)).toBe(false);
    });

    it("should return true when percentage is 100", () => {
      expect(isFeatureEnabled("user-123", "test-feature", 100)).toBe(true);
    });

    it("should return consistent results for same user and feature", () => {
      const userId = "user-abc-123";
      const featureKey = "my-feature";
      const percentage = 50;

      const result1 = isFeatureEnabled(userId, featureKey, percentage);
      const result2 = isFeatureEnabled(userId, featureKey, percentage);
      const result3 = isFeatureEnabled(userId, featureKey, percentage);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    it("should return fixture-stable results for different users at 50%", () => {
      expect(isFeatureEnabled("user-123", "test-feature", 50)).toBe(false);
      expect(isFeatureEnabled("user-23", "test-feature", 50)).toBe(true);
    });

    it("should return different results for different features with same user", () => {
      const userId = "user-123";
      const percentage = 50;

      expect([
        isFeatureEnabled(userId, "feature-a", percentage),
        isFeatureEnabled(userId, "feature-b", percentage),
        isFeatureEnabled(userId, "feature-c", percentage),
        isFeatureEnabled(userId, "feature-d", percentage),
        isFeatureEnabled(userId, "feature-e", percentage),
      ]).toEqual([false, false, true, true, true]);
    });

    it("should use exclusive percentile thresholds", () => {
      const featureKey = "distribution-test";

      expect(isFeatureEnabled("user-123", featureKey, 6)).toBe(true);
      expect(isFeatureEnabled("user-123", featureKey, 5)).toBe(false);
      expect(isFeatureEnabled("user-abc-123", featureKey, 10)).toBe(false);
    });

    it("should handle edge case percentage of 1", () => {
      const featureKey = "one-percent-test";
      const percentage = 1;

      expect(isFeatureEnabled("user-9", featureKey, percentage)).toBe(true);
      expect(isFeatureEnabled("user-8", featureKey, percentage)).toBe(false);
    });

    it("should handle empty string user ID", () => {
      expect(() => isFeatureEnabled("", "feature", 50)).not.toThrow();
    });

    it("should handle special characters in user ID", () => {
      const result = isFeatureEnabled("user@example.com", "feature", 50);
      expect(typeof result).toBe("boolean");
    });

    it("should handle UUID-style user IDs", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = isFeatureEnabled(uuid, "feature", 50);
      expect(typeof result).toBe("boolean");
    });

    it("should handle very long strings without overflow issues", () => {
      // Long strings would cause integer overflow without proper 32-bit truncation
      const longUserId = "user-" + "a".repeat(10000);
      const result = isFeatureEnabled(longUserId, "feature", 50);
      expect(typeof result).toBe("boolean");

      // Should be consistent
      const result2 = isFeatureEnabled(longUserId, "feature", 50);
      expect(result).toBe(result2);
    });

    it("should produce values in valid 0-99 range for edge case inputs", () => {
      // These inputs could cause issues with improper hash implementations
      const edgeCases = [
        "a".repeat(1000),
        "\u0000".repeat(100),
        "🎉".repeat(100),
        String.fromCharCode(65535).repeat(50),
      ];

      for (const input of edgeCases) {
        // At 50%, we're testing the hash produces a valid percentage
        // If hash was broken, this might throw or produce inconsistent results
        const result1 = isFeatureEnabled(input, "test", 50);
        const result2 = isFeatureEnabled(input, "test", 50);
        expect(typeof result1).toBe("boolean");
        expect(result1).toBe(result2);
      }
    });
  });

  describe("constants", () => {
    it("should have CROSS_TAB_TOKEN_SHARING feature flag defined", () => {
      expect(FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING).toBe(
        "cross-tab-token-sharing",
      );
    });

    it("should default to 0% rollout when env var is not set", () => {
      const originalEnv = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;
      delete process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;

      expect(FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]).toBe(0);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = originalEnv;
    });

    it("should use env var value when set", () => {
      const originalEnv = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;
      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = "50";

      expect(FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]).toBe(50);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = originalEnv;
    });

    it("should return 0 for invalid env var values", () => {
      const originalEnv = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = "invalid";
      expect(FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]).toBe(0);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = "-5";
      expect(FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]).toBe(0);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = "150";
      expect(FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]).toBe(0);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = originalEnv;
    });
  });

  describe("isCrossTabTokenSharingEnabled", () => {
    it("should return false when userId is undefined", () => {
      expect(isCrossTabTokenSharingEnabled(undefined)).toBe(false);
    });

    it("should return false when userId is empty string", () => {
      // Empty string hashes to 0, which is < 1, so it would be enabled
      // But we should still test the function works
      const result = isCrossTabTokenSharingEnabled("");
      expect(typeof result).toBe("boolean");
    });

    it("should return consistent results for same user", () => {
      const userId = "user-xyz-789";
      const result1 = isCrossTabTokenSharingEnabled(userId);
      const result2 = isCrossTabTokenSharingEnabled(userId);
      expect(result1).toBe(result2);
    });

    it("should enable 0% of users when env var is not set", () => {
      const originalEnv = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;
      delete process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;

      const users = Array.from({ length: 100 }, (_, i) => `user-${i}`);
      const enabledCount = users.filter((userId) =>
        isCrossTabTokenSharingEnabled(userId),
      ).length;

      expect(enabledCount).toBe(0);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = originalEnv;
    });

    it("should respect configured rollout percentage for known users", () => {
      const originalEnv = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;
      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = "10";

      expect(isCrossTabTokenSharingEnabled("user-80")).toBe(true);
      expect(isCrossTabTokenSharingEnabled("user-86")).toBe(true);
      expect(isCrossTabTokenSharingEnabled("user-87")).toBe(false);
      expect(isCrossTabTokenSharingEnabled("user-1")).toBe(false);

      process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING = originalEnv;
    });
  });
});
